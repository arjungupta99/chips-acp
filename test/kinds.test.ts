/**
 * The agents this bridge knows by name that speak ACP themselves (Chips ADR 0301): run as the
 * agent's own command, asked for with the maker's line, and never anything fetched for them.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Install, makersFolder, readyAdapter, withFetchedAdapter } from "../src/adapter.ts";
import type { KindConfig } from "../src/bridge.ts";
import { AcpError, agentWords } from "../src/acp.ts";
import { installWords, keptEnvOf, knownConfig, knownIdOf, knownOf, modesOf, notInstalledStop, signedOutBy, signedOutStop, signedOutWords } from "../src/kinds.ts";
import { lookAt } from "../src/models.ts";
import { copilotOwnRules, grokModeFrom, grokModeOf, grokOwnRules, grokRulesOf, modeOwnRules } from "../src/own-rules.ts";
import { checkCommand, readConfig, SetupError } from "../src/setup.ts";

const root = mkdtempSync(join(tmpdir(), "chips-acp-kinds-"));
let count = 0;

/** A home and a folder for the PATH, each new, with `programs` installed in the folder. */
function machine(...programs: string[]) {
  count += 1;
  const home = join(root, `home-${count}`);
  const bin = join(root, `bin-${count}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const program of programs) {
    writeFileSync(join(bin, program), "#!/bin/sh\n");
    chmodSync(join(bin, program), 0o755);
  }
  return { home, bin };
}

const kindOf = (id: string): KindConfig => ({ ...knownConfig(id)!, folders: join(root, "rooms") });
const npm = "/chips/runtime/npm/bin/npm-cli.js";

/** Each agent that speaks ACP itself: its id, name, command, and the maker's install line. */
const NATIVE = [
  ["cursor", "Cursor", ["cursor-agent", "acp"], "curl https://cursor.com/install -fsS | bash", ".local/bin"],
  [
    "goose",
    "Goose",
    ["goose", "acp"],
    "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash",
    ".local/bin",
  ],
  ["copilot", "Copilot", ["copilot", "--acp"], "curl -fsSL https://gh.io/copilot-install | bash", ".local/bin"],
  ["antigravity", "Antigravity", ["agy", "acp"], "curl -fsSL https://antigravity.google/cli/install.sh | bash", ".local/bin"],
  ["grok", "Grok", ["grok", "agent", "stdio"], "curl -fsSL https://x.ai/cli/install.sh | bash", ".grok/bin"],
] as const;

describe("an agent that speaks ACP itself", () => {
  it("runs as its own command, from a card's config file that isn't there", () => {
    for (const [id, name, command] of NATIVE) {
      const kind = kindOf(id);
      assert.equal(kind.name, name);
      assert.deepEqual(kind.command, command);
      // A config named for it needs no file: the card hands `~/Chips/.bridges/acp/<id>.json`.
      const read = readConfig(join(root, "nowhere", `${id}.json`));
      assert.deepEqual(read.command, command);
      assert.match(read.folders, new RegExp(`Chips/Agents/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}$`));
    }
  });

  it("is asked for with its maker's line, and nothing is fetched for it, npm or no npm", async () => {
    for (const [id, name, , line] of NATIVE) {
      const { home, bin } = machine();
      const jobs: Install[] = [];
      const install = async (job: Install) => {
        jobs.push(job);
      };
      await assert.rejects(readyAdapter(kindOf(id), { home, env: { PATH: bin, CHIPS_NPM: npm }, install }), (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.match(error.message, new RegExp(`^${name} isn't installed on this machine: run \``));
        assert.deepEqual(error.words, {
          detail: `${name} isn't on this Mac`,
          says: `${name} isn't installed on this Mac.`,
          doing: "Run this in Terminal, then try again.",
          copy: line,
        });
        return true;
      });
      const there = machine(kindOf(id).command[0]!);
      const ready = await readyAdapter(kindOf(id), { home: there.home, env: { PATH: there.bin, CHIPS_NPM: npm }, install });
      assert.deepEqual(ready.command, kindOf(id).command);
      assert.deepEqual(withFetchedAdapter(kindOf(id), { PATH: there.bin }, there.home).command, kindOf(id).command);
      assert.equal(jobs.length, 0);
    }
  });

  it("not on the PATH, says the maker's line, never an adapter to install from npm", () => {
    for (const [id, name, , line] of NATIVE) {
      const { bin } = machine();
      assert.equal(installWords(kindOf(id)), `install it with \`${line}\``);
      assert.deepEqual(notInstalledStop(kindOf(id), kindOf(id).command[0]!).copy, line);
      assert.throws(
        () => checkCommand(kindOf(id), { PATH: bin }),
        (error: unknown) => error instanceof SetupError && error.message.includes(line) && !error.message.includes("npm install"),
        name,
      );
    }
  });

  it("is found where its maker's installer put it, which a terminal opened before doesn't know yet", () => {
    for (const [id, , command, , folder] of NATIVE) {
      const { home, bin } = machine();
      assert.equal(makersFolder(kindOf(id), { PATH: bin }, home), undefined);
      const makers = join(home, folder);
      mkdirSync(makers, { recursive: true });
      writeFileSync(join(makers, command[0]), "#!/bin/sh\n");
      chmodSync(join(makers, command[0]), 0o755);
      assert.equal(makersFolder(kindOf(id), { PATH: bin }, home), makers);
    }
  });

  it("offers its models but none of Claude Code's or Codex's files, and carries its own key to the kept copy", () => {
    for (const [id] of NATIVE) {
      assert.equal(knownIdOf(kindOf(id)), undefined);
      assert.ok(knownOf(kindOf(id)));
    }
    assert.ok(keptEnvOf(kindOf("grok")).includes("XAI_API_KEY"));
    assert.ok(keptEnvOf(kindOf("antigravity")).includes("GEMINI_API_KEY"));
    // Copilot's own token only: the gh command's would beat the sign-in Copilot saved.
    assert.ok(keptEnvOf(kindOf("copilot")).includes("COPILOT_GITHUB_TOKEN"));
    assert.ok(!keptEnvOf(kindOf("copilot")).includes("GH_TOKEN"));
    assert.ok(keptEnvOf(kindOf("grok")).includes("ANTHROPIC_API_KEY"));
    assert.ok(!keptEnvOf(kindOf("codex")).includes("XAI_API_KEY"));
    assert.equal(knownIdOf(kindOf("codex")), "codex");
    assert.equal(knownIdOf(kindOf("claude-code")), "claude-code");
  });
});

describe("a kind known by name only, on the Permissions page", () => {
  it("offers no mode to pick where its sessions have none Chips may put them in", () => {
    for (const id of ["grok", "copilot", "cursor"]) {
      assert.equal(kindOf(id).mode, undefined);
      assert.deepEqual(modesOf(kindOf(id)), []);
    }
  });

  it("offers Antigravity's three that say how much it may do, starting in the one that asks, and no Plan", () => {
    assert.equal(kindOf("antigravity").mode, "default");
    assert.deepEqual(
      modesOf(kindOf("antigravity")).map((mode) => [mode.id, mode.name]),
      [
        ["default", "Default"],
        ["accept-edits", "Accept edits"],
        ["auto", "Auto"],
      ],
    );
    assert.equal(modesOf(kindOf("antigravity")).some((mode) => mode.everything === true), false);
  });

  it("puts Goose in Approve, not the Auto it starts in, which never asks", () => {
    assert.equal(kindOf("goose").mode, "approve");
    assert.deepEqual(
      modesOf(kindOf("goose")).map((mode) => [mode.id, mode.everything === true]),
      [
        ["approve", false],
        ["smart_approve", false],
        ["auto", true],
      ],
    );
  });

  it("says the mode it runs in, in its own words, and nothing it runs beside", () => {
    const asks = { id: "ask", name: "Ask", words: "Asks before it edits or runs anything." };
    const never = { id: "yolo", name: "Yolo", words: "Never asks.", everything: true as const };
    assert.deepEqual(modeOwnRules("Thing", "ask", asks), {
      read_from: ["the mode Chips starts each Thing session in"],
      mode: "Ask",
      note: "Asks before it edits or runs anything.",
      runs: [],
    });
    assert.deepEqual(modeOwnRules("Thing", "yolo", never), {
      read_from: ["the mode Chips starts each Thing session in"],
      mode: "Yolo",
      everything: true,
      note: "Never asks.",
      runs: [],
    });
    // A mode the agent went into that the kind doesn't name is said by its id.
    assert.deepEqual(modeOwnRules("Thing", "plan", undefined), {
      read_from: ["the mode Chips starts each Thing session in"],
      mode: "plan",
      runs: [],
    });
  });
});

describe("an agent with nothing to run on", () => {
  it("is Goose with no model provider, said as what it lacks, with the line that sets one up", () => {
    const unset = new AcpError("Internal error", -32603, "Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER");
    assert.equal(signedOutBy(kindOf("goose"), unset), true);
    assert.equal(signedOutBy(kindOf("goose"), new AcpError("Internal error", -32603, "disk full")), false);
    // Only Goose's words for it: another kind's internal error is its own.
    assert.equal(signedOutBy(kindOf("cursor"), unset), false);
    assert.equal(signedOutBy(kindOf("cursor"), new AcpError("Authentication required", -32000)), true);
    assert.equal(
      signedOutWords(kindOf("goose")),
      "Goose has no model provider set up on this machine: run `goose configure` and pick a model provider in a new terminal.",
    );
    assert.deepEqual(signedOutStop(kindOf("goose")), {
      detail: "No model provider",
      says: "Goose has no model provider set up.",
      doing: "Run this in Terminal, then try again. It asks which model provider to use, and for its key.",
      copy: "goose configure",
    });
    assert.equal(signedOutStop(kindOf("cursor")).copy, "cursor-agent login");
  });
});

describe("an agent's models, as a kind known by name offers them", () => {
  it("names each once, though Copilot on GitHub's free plan lists Auto twice", async () => {
    const options = [
      {
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "auto",
        options: [
          { value: "auto", name: "Auto" },
          { value: "auto", name: "Auto" },
        ],
      },
    ];
    const { catalog } = await lookAt(options, async () => options);
    assert.deepEqual(catalog?.choices.map((choice) => choice.id), ["auto"]);
    assert.equal(catalog?.default.model, "auto");
  });
});

describe("an agent's refusal, in its own words", () => {
  it("is what its details say where JSON-RPC's message is only Internal error", () => {
    const grok = new AcpError("Internal error", -32603, {
      message: "API error (status 426 Upgrade Required): Your Grok CLI version (0.2.99) is outdated.",
      http_status: 426,
    });
    assert.equal(agentWords(grok), "API error (status 426 Upgrade Required): Your Grok CLI version (0.2.99) is outdated.");
    assert.equal(agentWords(new AcpError("Internal error", -32603, "Failed to resolve provider and model")), "Failed to resolve provider and model");
    // Its own message where it says one, or where the details say nothing.
    assert.equal(agentWords(new AcpError("Authentication required", -32000, { message: "x" })), "Authentication required");
    assert.equal(agentWords(new AcpError("Internal error", -32603)), "Internal error");
  });
});

describe("Copilot's and Grok's own permissions, on the Permissions page", () => {
  it("is Copilot's Allow all: asks first while it's off, never asks while it's on", () => {
    assert.deepEqual(copilotOwnRules("off"), {
      read_from: ["Copilot's Allow all, as its sessions say it"],
      mode: "Asks first",
      note: "Copilot asks before it uses a tool, reaches a path or fetches a URL.",
      runs: [],
    });
    assert.equal(copilotOwnRules(undefined).mode, "Asks first");
    assert.deepEqual(copilotOwnRules("on"), {
      read_from: ["Copilot's Allow all, as its sessions say it"],
      mode: "Allow all",
      everything: true,
      note: "Copilot approves every tool, path and URL request without asking.",
      runs: [],
    });
  });

  const CONFIG = [
    "[cli]",
    "auto_update = true",
    "",
    "[ui]",
    "yolo = false",
    'permission_mode = "ask" # or auto',
    "",
    "[permission]",
    "rules = [",
    '  { action = "allow", tool = "bash", pattern = "git *" },',
    '  { action = "allow", tool = "read" },',
    '  { tool = "bash", action = "deny", pattern = "rm -rf *" },',
    '  { action = "ask", tool = "WebFetch" },',
    "]",
    "",
    "[[marketplace.sources]]",
    'name = "x"',
  ].join("\n");

  it("reads Grok's mode from its config, the newest way of saying it first", () => {
    assert.equal(grokModeOf(CONFIG), "ask");
    assert.equal(grokModeOf('[ui]\npermission_mode = "auto"'), "auto");
    assert.equal(grokModeOf("[ui]\nyolo = true"), "always-approve");
    assert.equal(grokModeOf('[ui]\nyolo = true\npermission_mode = "ask"'), "ask");
    assert.equal(grokModeOf('[other]\npermission_mode = "auto"'), "ask");
    assert.equal(grokModeOf(undefined), "ask");
  });

  it("takes Grok's mode from Claude Code's defaultMode first, the most specific file's, then from its own config", () => {
    const config = { path: "/Users/ada/.grok/config.toml", toml: CONFIG };
    const user = (defaultMode: string) => ({ path: "/Users/ada/.claude/settings.json", layer: { permissions: { defaultMode } } });
    const local = (defaultMode: string) => ({ path: "/Users/ada/.claude/settings.local.json", layer: { permissions: { defaultMode } } });
    // Grok 1.0.89 ran in Auto from Claude Code's settings while its own config said ask.
    assert.deepEqual(grokModeFrom(config, [user("auto")]), { mode: "auto", from: "/Users/ada/.claude/settings.json" });
    assert.deepEqual(grokModeFrom(config, [user("auto"), local("dontAsk")]), { mode: "dont-ask", from: "/Users/ada/.claude/settings.local.json" });
    assert.equal(grokModeFrom(config, [user("acceptEdits")]).mode, "accept-edits");
    assert.equal(grokModeFrom(config, [user("bypassPermissions")]).mode, "always-approve");
    // Plan isn't a mode Grok's ACP sessions go into.
    assert.equal(grokModeFrom(config, [user("plan")]).mode, "ask");
    // A mode Grok doesn't know, or none, leaves it to Grok's own config.
    assert.deepEqual(grokModeFrom(config, [user("sideways"), { path: "/x/.claude/settings.json", layer: {} }]), {
      mode: "ask",
      from: "/Users/ada/.grok/config.toml",
    });
    assert.deepEqual(grokModeFrom({ path: config.path, toml: '[ui]\npermission_mode = "auto"' }, []), { mode: "auto", from: config.path });
    assert.deepEqual(grokModeFrom({ path: config.path, toml: undefined }, []), { mode: "ask" });
  });

  it("says when Grok's mode comes from Claude Code's settings, and lists that file", () => {
    const home = "/Users/ada";
    const copy = grokOwnRules({
      configPath: `${home}/.grok/config.toml`,
      config: '[ui]\npermission_mode = "ask"',
      claude: [{ path: `${home}/.claude/settings.json`, layer: { permissions: { defaultMode: "auto" } } }],
      home,
    });
    assert.deepEqual(copy.read_from, ["~/.grok/config.toml", "~/.claude/settings.json"]);
    assert.equal(copy.mode, "Auto");
    assert.equal(
      copy.note,
      "Grok's own check lets safe steps through, and blocks or asks about the rest. Grok takes this mode from defaultMode in ~/.claude/settings.json, ahead of its own config.",
    );
    // Accept edits lets every edit through.
    const edits = grokOwnRules({
      configPath: `${home}/.grok/config.toml`,
      config: undefined,
      claude: [{ path: `${home}/.claude/settings.json`, layer: { permissions: { defaultMode: "acceptEdits", allow: ["Bash(git:*)"] } } }],
      home,
    });
    assert.equal(edits.mode, "Accept edits");
    assert.deepEqual(
      edits.runs.map((entry) => [entry.kind, entry.name, entry.raw]),
      [
        ["command", "Bash", "Bash(git:*)"],
        ["write", "Edit", "acceptEdits"],
      ],
    );
  });

  it("reads Grok's own rules, whatever order their keys are in", () => {
    const rules = grokRulesOf(CONFIG);
    assert.deepEqual(
      rules.allow.map((entry) => [entry.kind, entry.name, entry.words]),
      [
        ["command", "bash", ["git"]],
        ["read", "read", undefined],
      ],
    );
    assert.deepEqual(rules.deny.map((entry) => [entry.kind, entry.words]), [["command", ["rm", "-rf"]]]);
    assert.deepEqual(rules.ask.map((entry) => entry.kind), ["web"]);
  });

  it("joins Grok's own rules with the Claude Code ones it follows, and says where each came from", () => {
    const home = "/Users/ada";
    const copy = grokOwnRules({
      configPath: `${home}/.grok/config.toml`,
      config: CONFIG,
      claude: [{ path: `${home}/.claude/settings.local.json`, layer: { permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"] } } }],
      home,
    });
    assert.deepEqual(copy.read_from, ["~/.grok/config.toml", "~/.claude/settings.local.json"]);
    assert.equal(copy.mode, "Ask");
    assert.equal(
      copy.note,
      "Grok asks before anything but read-only steps and what its rules allow. It follows your Claude Code permission rules too, as listed here.",
    );
    // Grok's own first, then the Claude Code ones, each as written.
    assert.deepEqual(
      copy.runs.map((entry) => [entry.name, entry.raw]),
      [
        ["bash", '{action = "allow", tool = "bash", pattern = "git *"}'],
        ["read", '{action = "allow", tool = "read"}'],
        ["Bash", "Bash(npm test:*)"],
      ],
    );
    assert.deepEqual(copy.refuses?.map((entry) => entry.name), ["bash", "Read"]);
    // Always-approve lets everything through: nothing to list.
    const yolo = grokOwnRules({ configPath: `${home}/.grok/config.toml`, config: "[ui]\nyolo = true", claude: [], home });
    assert.deepEqual(yolo, {
      read_from: ["~/.grok/config.toml"],
      mode: "Always-approve",
      everything: true,
      note: "Grok approves every step without asking: only deny rules and hooks stop one.",
      runs: [],
    });
  });
});

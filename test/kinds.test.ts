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
import { AcpError } from "../src/acp.ts";
import { installWords, keptEnvOf, knownConfig, knownIdOf, knownOf, modesOf, notInstalledStop, signedOutBy, signedOutStop, signedOutWords } from "../src/kinds.ts";
import { modeOwnRules } from "../src/own-rules.ts";
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
  ["grok", "Grok", ["grok", "--no-auto-update", "agent", "stdio"], "curl -fsSL https://x.ai/cli/install.sh | bash", ".grok/bin"],
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

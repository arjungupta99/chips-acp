/**
 * Getting a known kind's adapter when Connect needs it (Chips ADR 0288): the agent asked for first,
 * the adapter fetched where it may be, and found again at every start.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  adapterFolder,
  forgetAdapter,
  type Install,
  makersFolder,
  pathWithLast,
  readyAdapter,
  withFetchedAdapter,
} from "../src/adapter.ts";
import type { KindConfig } from "../src/bridge.ts";
import { knownConfig } from "../src/kinds.ts";
import { checkCommand, SetupError } from "../src/setup.ts";

const root = mkdtempSync(join(tmpdir(), "chips-acp-adapter-"));
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

/** An install that puts the adapter's command where npm would, and notes what it was asked. */
function fakeInstall(program: string) {
  const jobs: Install[] = [];
  const install = async (job: Install) => {
    jobs.push(job);
    const dir = join(job.folder, "node_modules", ".bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, program), "#!/bin/sh\n");
    chmodSync(join(dir, program), 0o755);
  };
  return { jobs, install };
}

const npm = "/chips/runtime/npm/bin/npm-cli.js";

describe("the adapter, when Connect needs it", () => {
  it("asks for the agent first, with its maker's line, before anything is downloaded", async () => {
    for (const [id, name, line] of [
      ["codex", "Codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
      ["claude-code", "Claude Code", "curl -fsSL https://claude.ai/install.sh | bash"],
    ] as const) {
      const { home, bin } = machine();
      const fake = fakeInstall("nothing");
      await assert.rejects(readyAdapter(kindOf(id), { home, env: { PATH: bin, CHIPS_NPM: npm }, install: fake.install }), (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.equal(
          error.message,
          `${name} isn't installed on this machine: run \`${line}\`. The link is still good: run the same command again once that's done. If ${name} still isn't found, run that command in a new terminal.`,
        );
        assert.deepEqual(error.words, {
          detail: `${name} isn't on this Mac`,
          says: `${name} isn't installed on this Mac.`,
          doing: "Run this in Terminal, then try again.",
          copy: line,
        });
        return true;
      });
      assert.equal(fake.jobs.length, 0);
    }
  });

  it("finds an agent its maker's installer has just put in ~/.local/bin, which this terminal's PATH doesn't have yet", async () => {
    for (const [id, agent] of [
      ["codex", "codex"],
      ["claude-code", "claude"],
    ] as const) {
      const { home, bin } = machine();
      // Nowhere: nothing to add.
      assert.equal(makersFolder(kindOf(id), { PATH: bin }, home), undefined);
      const makers = join(home, ".local", "bin");
      mkdirSync(makers, { recursive: true });
      // There, but not something to run: still nowhere.
      writeFileSync(join(makers, agent), "#!/bin/sh\n");
      assert.equal(makersFolder(kindOf(id), { PATH: bin }, home), undefined);
      chmodSync(join(makers, agent), 0o755);
      assert.equal(makersFolder(kindOf(id), { PATH: bin }, home), makers);
      // With the folder last on the PATH, the agent is found and the stop for it is gone.
      const env = { PATH: pathWithLast(bin, makers), CHIPS_NPM: npm };
      const fake = fakeInstall(id === "codex" ? "codex-acp" : "nothing");
      const ready = await readyAdapter(kindOf(id), { home, env, install: fake.install });
      assert.equal(fake.jobs.length, id === "codex" ? 1 : 0);
      if (id === "codex") assert.equal(ready.command[0], join(adapterFolder("codex", home), "node_modules", ".bin", "codex-acp"));
      // Claude Code's adapter isn't fetched, so what is said next is the adapter, not the agent.
      else assert.throws(() => checkCommand(ready, env), /Claude Code's command, claude-agent-acp, isn't on this machine's PATH/);
    }
  });

  it("adds nothing for an agent the PATH already finds, or a kind that names its own command", () => {
    const { home, bin } = machine("codex");
    const makers = join(home, ".local", "bin");
    mkdirSync(makers, { recursive: true });
    writeFileSync(join(makers, "codex"), "#!/bin/sh\n");
    chmodSync(join(makers, "codex"), 0o755);
    assert.equal(makersFolder(kindOf("codex"), { PATH: bin }, home), undefined);
    const own: KindConfig = { name: "Mine", command: ["my-agent"], folders: join(root, "rooms") };
    assert.equal(makersFolder(own, { PATH: bin }, home), undefined);
    // Last, so whatever the PATH already finds is still found first; no empty entry, which a shell reads as "here".
    assert.equal(pathWithLast("/a:/b", "/c"), "/a:/b:/c");
    assert.equal(pathWithLast("", "/c"), "/c");
    assert.equal(pathWithLast(undefined, "/c"), "/c");
  });

  it("uses an adapter already on the PATH, agent or no agent, and fetches nothing", async () => {
    const { home, bin } = machine("codex-acp");
    const fake = fakeInstall("codex-acp");
    const ready = await readyAdapter(kindOf("codex"), { home, env: { PATH: bin, CHIPS_NPM: npm }, install: fake.install });
    assert.deepEqual(ready.command, ["codex-acp"]);
    assert.equal(fake.jobs.length, 0);
  });

  it("fetches Codex's adapter when the agent is there, into its own folder, keeping the link from npm", async () => {
    const { home, bin } = machine("codex");
    const fake = fakeInstall("codex-acp");
    const said: string[] = [];
    const ready = await readyAdapter(kindOf("codex"), {
      home,
      env: { PATH: bin, CHIPS_NPM: npm, CHIPS_JOIN_LINK: "http://chips/j/secret" },
      install: fake.install,
      say: (line) => said.push(line),
    });
    assert.equal(fake.jobs[0]?.spec, "@agentclientprotocol/codex-acp@2");
    assert.equal(fake.jobs[0]?.npm, npm);
    assert.equal(fake.jobs[0]?.folder, adapterFolder("codex", home));
    assert.equal(fake.jobs[0]?.env["CHIPS_JOIN_LINK"], undefined);
    assert.deepEqual(ready.command, [join(adapterFolder("codex", home), "node_modules", ".bin", "codex-acp")]);
    assert.match(said[0] ?? "", /Getting what Codex needs/);
    checkCommand(ready, { PATH: bin });
  });

  it("fetches nothing for Claude Code yet, and says what to run in plain words", async () => {
    const { home, bin } = machine("claude");
    const fake = fakeInstall("claude-agent-acp");
    const kind = await readyAdapter(kindOf("claude-code"), { home, env: { PATH: bin, CHIPS_NPM: npm }, install: fake.install });
    assert.deepEqual(kind.command, ["claude-agent-acp"]);
    assert.equal(fake.jobs.length, 0);
    assert.throws(
      () => checkCommand(kind, { PATH: bin }),
      (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.equal(error.words.says, "Claude Code needs one more piece to join Chips.");
        assert.equal(error.words.copy, "npm install -g @agentclientprotocol/claude-agent-acp");
        return true;
      },
    );
  });

  it("leaves it to checkCommand where Chips carries no npm", async () => {
    const { home, bin } = machine("codex");
    const fake = fakeInstall("codex-acp");
    const kind = await readyAdapter(kindOf("codex"), { home, env: { PATH: bin }, install: fake.install });
    assert.deepEqual(kind.command, ["codex-acp"]);
    assert.equal(fake.jobs.length, 0);
  });

  it("stops with what to do when the download fails, and leaves no half of it behind", async () => {
    const { home, bin } = machine("codex");
    await assert.rejects(
      readyAdapter(kindOf("codex"), {
        home,
        env: { PATH: bin, CHIPS_NPM: npm },
        install: async (job) => {
          writeFileSync(join(job.folder, "half"), "");
          throw new Error("no network");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SetupError);
        assert.equal(error.words.says, "Chips couldn't get what Codex needs.");
        return true;
      },
    );
    assert.equal(existsSync(adapterFolder("codex", home)), false);
  });

  it("finds the fetched adapter again at the next start, and forgets it on disconnect", async () => {
    const { home, bin } = machine("codex");
    const fake = fakeInstall("codex-acp");
    await readyAdapter(kindOf("codex"), { home, env: { PATH: bin, CHIPS_NPM: npm }, install: fake.install });
    const again = withFetchedAdapter(kindOf("codex"), { PATH: bin }, home);
    assert.deepEqual(again.command, [join(adapterFolder("codex", home), "node_modules", ".bin", "codex-acp")]);
    forgetAdapter("codex", home);
    assert.deepEqual(withFetchedAdapter(kindOf("codex"), { PATH: bin }, home).command, ["codex-acp"]);
  });

  it("leaves a kind that names its own command alone", async () => {
    const { home, bin } = machine();
    const own = { ...kindOf("codex"), command: [join(bin, "codex-acp")] };
    assert.deepEqual((await readyAdapter(own, { home, env: { PATH: bin, CHIPS_NPM: npm } })).command, own.command);
  });
});

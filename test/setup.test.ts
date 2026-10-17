/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * config that isn't there, an agent command this machine can't find, or an agent that doesn't
 * start or isn't signed in, stops it first.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Wire } from "../src/acp.ts";
import { checkCommand, checkSignIn, readConfig, SetupError, STILL_GOOD } from "../src/setup.ts";
import { fakeAgent } from "./fake-agent.ts";

const folder = mkdtempSync(join(tmpdir(), "chips-acp-setup-"));
const bin = join(folder, "bin");
const config = join(folder, "claude-code.json");
writeFileSync(config, JSON.stringify({ name: "Claude Code", command: ["claude-agent-acp"], folders: join(folder, "rooms") }));
// An agent installed: an executable of its command's name, in a folder of its own.
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "claude-agent-acp"), "#!/bin/sh\n");
chmodSync(join(bin, "claude-agent-acp"), 0o755);

const stopsWith = (pattern: RegExp) => (error: unknown) =>
  error instanceof SetupError && pattern.test(error.message) && error.message.includes(STILL_GOOD);

describe("before the link is taken up", () => {
  it("stops on a config that isn't there, saying what to write", () => {
    assert.throws(() => readConfig(join(folder, "none.json")), stopsWith(/no config at .*"command".*claude-code\.json or codex\.json/));
  });

  it("needs no config for Claude Code or Codex, as the gallery's cards name them", () => {
    const claude = readConfig(join(folder, "nowhere", "claude-code.json"));
    assert.deepEqual([claude.name, claude.command, claude.mode], ["Claude Code", ["claude-agent-acp"], "default"]);
    assert.match(claude.folders, /\/chips-acp\/claude-code$/);
    const codex = readConfig(join(folder, "nowhere", "codex.json"));
    assert.deepEqual([codex.name, codex.command, codex.mode], ["Codex", ["codex-acp"], "workspace-write"]);
    assert.match(codex.folders, /\/chips-acp\/codex$/);
  });

  it("says how to install a known kind's adapter", () => {
    const codex = readConfig(join(folder, "nowhere", "codex.json"));
    assert.throws(() => checkCommand(codex, { PATH: "/nowhere" }), stopsWith(/`npm install -g @agentclientprotocol\/codex-acp`/));
  });

  it("stops when the agent's command isn't on the PATH, and goes on once it is", () => {
    const kind = readConfig(config);
    assert.throws(() => checkCommand(kind, { PATH: "/nowhere" }), stopsWith(/claude-agent-acp, isn't on this machine's PATH/));
    checkCommand(kind, { PATH: `/nowhere:${bin}` });
  });

  it("takes a command named by its path", () => {
    const kind = { ...readConfig(config), command: [join(bin, "claude-agent-acp")] };
    checkCommand(kind, { PATH: "" });
    assert.throws(() => checkCommand({ ...kind, command: [join(bin, "gone")] }, { PATH: "" }), SetupError);
  });
});

describe("the agent started and signed in, before the link is taken up", () => {
  const kind = { name: "Claude Code", command: ["claude-agent-acp"], folders: folder };
  const codex = { name: "Codex", command: ["codex-acp"], folders: folder };

  it("goes on when it says it is signed in, or says nothing of it, letting its session go", async () => {
    const agent = fakeAgent({ auth: "in", close: true });
    await checkSignIn(kind, agent.wire(), folder);
    assert.deepEqual(agent.closed, agent.made);
    await checkSignIn(kind, fakeAgent().wire(), folder);
  });

  it("stops when it says it is signed in as nobody, as Claude Code does, with how to sign in", async () => {
    await assert.rejects(
      checkSignIn(kind, fakeAgent({ auth: "out" }).wire(), folder),
      stopsWith(/^Claude Code isn't signed in on this machine: run `claude`, then \/login in a terminal\./),
    );
  });

  it("stops when it refuses a session for it, as Codex does", async () => {
    await assert.rejects(
      checkSignIn(codex, fakeAgent({ auth: "out", refusesSessions: true }).wire(), folder),
      stopsWith(/^Codex isn't signed in on this machine: run `codex login` in a terminal\./),
    );
  });

  it("stops when it doesn't start, with what it said", async () => {
    const dead: Wire = {
      write: () => undefined,
      onLine: () => undefined,
      onClose: (handler) => setImmediate(() => handler("exited 1")),
      close: () => undefined,
    };
    await assert.rejects(
      checkSignIn(kind, dead, folder, { stderr: () => ["Error: no codex here"] }),
      stopsWith(/^Claude Code didn't start: the agent exited 1\. It said: Error: no codex here/),
    );
  });
});

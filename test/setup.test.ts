/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * config that isn't there, or an agent command this machine can't find, stops it first.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkCommand, readConfig, SetupError, STILL_GOOD } from "../src/setup.ts";

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
    assert.throws(() => readConfig(join(folder, "none.json")), stopsWith(/no config at .*"command"/));
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

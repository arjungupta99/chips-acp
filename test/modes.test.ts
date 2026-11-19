/** The mode a person picks in Chips for this kind's sessions (Chips ADR 0300, 19 November addendum). */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConfigOption } from "../src/acp.ts";
import type { KindConfig } from "../src/bridge.ts";
import { knownConfig, modesOf } from "../src/kinds.ts";
import { currentIn, modesCopy, modeTarget, offeredIn, onModeChange, pickedMode, withCurrent } from "../src/modes.ts";

const claude = { ...knownConfig("claude-code"), folders: "/tmp" } as KindConfig;
const codex = { ...knownConfig("codex"), folders: "/tmp" } as KindConfig;
const MODE: ConfigOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  currentValue: "default",
  options: ["default", "acceptEdits", "plan", "auto"].map((value) => ({ value, name: value })),
};

describe("the modes a person may pick", () => {
  it("are Claude Code's four and Codex's four, in plain words, for the kinds it knows in the mode it knows them by", () => {
    assert.deepEqual(
      modesOf(claude).map((mode) => mode.name),
      ["Default", "Accept edits", "Auto", "Bypass permissions"],
    );
    assert.deepEqual(
      modesOf(codex).map((mode) => mode.id),
      ["read-only", "workspace-write", "agent", "agent-full-access"],
    );
    assert.deepEqual(
      modesOf(claude).filter((mode) => mode.everything === true).map((mode) => mode.id),
      ["bypassPermissions"],
    );
    // A config of its own, or a known kind started in another mode, offers none.
    assert.deepEqual(modesOf({ name: "Gemini", command: ["gemini"], folders: "/tmp", mode: "default" }), []);
    assert.deepEqual(modesOf({ ...claude, mode: "auto" }), []);
  });

  it("are those the agent offers, the one it starts in always among them", () => {
    const copy = modesCopy(modesOf(claude), "default", "default", offeredIn([MODE]));
    assert.deepEqual(copy?.offers.map((mode) => mode.id), ["default", "acceptEdits", "auto"]);
    assert.equal(copy?.running, "default");
    // Before any session said, all of them.
    assert.equal(modesCopy(modesOf(claude), "default", undefined, undefined)?.offers.length, 4);
    assert.equal(modesCopy([], "default", undefined, undefined), undefined);
  });
});

describe("the mode a session goes in", () => {
  it("is the pick where the kind offers it and the agent has it, else the one it starts in, and why", () => {
    const modes = modesOf(claude);
    const offered = offeredIn([MODE]);
    assert.deepEqual(modeTarget("default", modes, undefined, offered), { mode: "default" });
    assert.deepEqual(modeTarget("default", modes, "auto", offered), { mode: "auto" });
    assert.deepEqual(modeTarget("default", modes, "auto", undefined), { mode: "auto" });
    assert.equal(modeTarget("default", modes, "bypassPermissions", offered).mode, "default");
    assert.match(modeTarget("default", modes, "bypassPermissions", offered).why ?? "", /doesn't offer bypassPermissions/);
    // Plan, or anything else, isn't Chips's to put it in.
    assert.equal(modeTarget("default", modes, "plan", offered).mode, "default");
  });

  it("is read off the session's mode option, and the agent's word moves it", () => {
    assert.equal(currentIn([MODE]), "default");
    assert.equal(currentIn(withCurrent([MODE], "acceptEdits")), "acceptEdits");
    assert.equal(offeredIn([]), undefined);
    assert.equal(currentIn(undefined), undefined);
  });

  it("comes from the SDK's pick where it hands one, and nothing from one before 1.0.11", () => {
    assert.equal(pickedMode({ mode: { id: "auto", until: "2030-01-01T00:00:00.000Z" } }), "auto");
    assert.equal(pickedMode({ mode: undefined }), undefined);
    assert.equal(pickedMode({}), undefined);
    const heard: string[] = [];
    const sdk = { mode: undefined, on: (name: string) => heard.push(name) };
    assert.equal(onModeChange(sdk, () => undefined), true);
    assert.deepEqual(heard, ["mode"]);
    assert.equal(onModeChange({ on: () => undefined }, () => undefined), false);
  });
});

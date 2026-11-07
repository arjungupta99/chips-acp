/**
 * An install from before 1.0.13 brought across to ~/Chips (Chips ADR 0283): the config and what the
 * kind keeps, its agents' folders, the paths its state saved and Claude Code's store for each folder,
 * one kind at a time, nothing copied, a clash left where it was, and nothing done twice.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { claudeStoreOf, moveOld } from "../src/move.ts";
import { configPathOf, configTargetOf } from "../src/places.ts";
import { readConfig } from "../src/setup.ts";

// Every default path is under a home of the test's own, never the person's.
let home = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};
const at = (path: string) => join(home, path);
const json = (path: string) => JSON.parse(readFileSync(at(path), "utf8")) as Record<string, unknown>;
const store = (path: string) => claudeStoreOf(at(path), {}, home) ?? "";

let said: string[] = [];
const log = (line: string) => said.push(line);
const move = (word: string) => moveOld(configTargetOf(word, home), log, home, {});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "chips-acp-move-")));
  process.env["HOME"] = home;
  said = [];
});

/** Claude Code and Codex as they were kept before 1.0.13. */
function oldInstall(): void {
  put(".chips-acp/claude-code.json", JSON.stringify({ name: "Claude Code", command: ["claude-agent-acp"], folders: "~/chips-acp/claude-code", env: { ANTHROPIC_API_KEY: "k" } }));
  put(".chips-acp/claude-code/chips-state.json", "{}");
  put(
    ".chips-acp/claude-code/state.json",
    JSON.stringify({ sessions: { "acp:1|spc": "s1" }, agents: { "acp:1": { key: "acp:1", agentId: "agt_1", name: "Miro", folder: at("chips-acp/claude-code/miro") } } }),
  );
  put("chips-acp/claude-code/CLAUDE.md", "Plain words.\n");
  put("chips-acp/claude-code/miro/notes.txt", "Miro's\n");
  put(".chips-acp/codex/state.json", "{}");
  put("chips-acp/codex/lionel/notes.txt", "Lionel's\n");
  mkdirSync(store("chips-acp/claude-code"), { recursive: true });
  writeFileSync(join(store("chips-acp/claude-code"), "check.jsonl"), "{}\n");
  mkdirSync(join(store("chips-acp/claude-code/miro"), "memory"), { recursive: true });
  writeFileSync(join(store("chips-acp/claude-code/miro"), "s1.jsonl"), "{}\n");
  writeFileSync(join(store("chips-acp/claude-code/miro"), "memory", "MEMORY.md"), "Miro remembers\n");
}

describe("where things are kept", () => {
  it("reads a config named in the old place as the same one in the new", () => {
    assert.equal(configPathOf("~/.chips-acp/claude-code.json", home), at("Chips/.bridges/acp/claude-code.json"));
    assert.equal(configPathOf(at(".chips-acp/codex.json"), home), at("Chips/.bridges/acp/codex.json"));
    assert.equal(configPathOf(undefined, home), at("Chips/.bridges/acp/config.json"));
    assert.equal(configPathOf("/elsewhere/mine.json", home), "/elsewhere/mine.json");
  });

  it("uses the old place while its file is there and the new one isn't", () => {
    put(".chips-acp/claude-code.json", "{}");
    assert.equal(configPathOf("~/.chips-acp/claude-code.json", home), at(".chips-acp/claude-code.json"));
  });

  it("gives a new kind its folders in ~/Chips/Agents", () => {
    assert.equal(readConfig(at("Chips/.bridges/acp/codex.json")).folders, at("Chips/Agents/codex"));
  });
});

describe("an install from before 1.0.13", () => {
  it("moves one kind's settings, folders, saved paths and Claude Code's stores, and leaves the other kind's", () => {
    oldInstall();
    move("~/.chips-acp/claude-code.json");

    const config = json("Chips/.bridges/acp/claude-code.json");
    assert.equal(config["folders"], "~/Chips/Agents/claude-code");
    assert.deepEqual(config["env"], { ANTHROPIC_API_KEY: "k" });
    assert.ok(existsSync(at("Chips/.bridges/acp/claude-code/chips-state.json")));
    const agents = json("Chips/.bridges/acp/claude-code/state.json")["agents"] as Record<string, { folder: string }>;
    assert.equal(agents["acp:1"]?.folder, at("Chips/Agents/claude-code/miro"));
    assert.equal(readFileSync(at("Chips/Agents/claude-code/miro/notes.txt"), "utf8"), "Miro's\n");
    assert.ok(existsSync(at("Chips/Agents/claude-code/CLAUDE.md")));
    assert.ok(existsSync(join(store("Chips/Agents/claude-code"), "check.jsonl")));
    assert.ok(existsSync(join(store("Chips/Agents/claude-code/miro"), "s1.jsonl")));
    assert.ok(existsSync(join(store("Chips/Agents/claude-code/miro"), "memory", "MEMORY.md")));
    assert.ok(!existsSync(store("chips-acp/claude-code/miro")));
    assert.equal(readConfig(at("Chips/.bridges/acp/claude-code.json")).folders, at("Chips/Agents/claude-code"));

    // Codex's, which another start moves, are where they were, and so are the folders holding them.
    assert.ok(existsSync(at(".chips-acp/codex/state.json")));
    assert.ok(existsSync(at("chips-acp/codex/lionel/notes.txt")));

    move("~/.chips-acp/codex.json");
    assert.ok(existsSync(at("Chips/.bridges/acp/codex/state.json")));
    assert.ok(existsSync(at("Chips/Agents/codex/lionel/notes.txt")));
    assert.ok(!existsSync(at(".chips-acp")), "the old settings folder goes once it is empty");
    assert.ok(!existsSync(at("chips-acp")), "and so does the old agents' folder");
  });

  it("does nothing the second time", () => {
    oldInstall();
    move("~/.chips-acp/claude-code.json");
    said = [];
    move("~/Chips/.bridges/acp/claude-code.json");
    assert.deepEqual(said, []);
  });

  it("moves into what is at the new place already, and leaves a clash where it was", () => {
    oldInstall();
    put("Chips/Agents/claude-code/miro/notes.txt", "a newer one\n");
    put("Chips/Agents/claude-code/pavel/plan.md", "Pavel's\n");
    move("~/.chips-acp/claude-code.json");

    assert.equal(readFileSync(at("Chips/Agents/claude-code/miro/notes.txt"), "utf8"), "a newer one\n");
    assert.equal(readFileSync(at("chips-acp/claude-code/miro/notes.txt"), "utf8"), "Miro's\n");
    assert.ok(existsSync(at("Chips/Agents/claude-code/CLAUDE.md")));
    assert.ok(existsSync(at("Chips/Agents/claude-code/pavel/plan.md")));
    assert.ok(said.some((line) => line.includes("~/chips-acp/claude-code/miro/notes.txt was left where it is")));
    // The folder is still in two places, so its saved path and Claude Code's store stay as they were.
    assert.ok(existsSync(join(store("chips-acp/claude-code/miro"), "s1.jsonl")));
  });

  it("leaves folders a config names elsewhere where they are", () => {
    put(".chips-acp/gemini.json", JSON.stringify({ name: "Gemini", command: ["gemini", "--acp"], folders: at("work/gemini") }));
    put("work/gemini/ada/notes.txt", "Ada's\n");
    move("~/.chips-acp/gemini.json");
    assert.ok(existsSync(at("Chips/.bridges/acp/gemini.json")));
    assert.ok(existsSync(at("work/gemini/ada/notes.txt")));
    assert.equal(readConfig(at("Chips/.bridges/acp/gemini.json")).folders, at("work/gemini"));
  });

  it("does nothing on a new install", () => {
    move("~/Chips/.bridges/acp/claude-code.json");
    assert.deepEqual(said, []);
    assert.ok(!existsSync(at("chips-acp")) && !existsSync(at(".chips-acp")));
  });
});

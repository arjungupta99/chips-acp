/**
 * What Claude Code's and Codex's own settings let through, as the copy for the harness's
 * Permissions page in Chips (Chips ADR 0299): read as Claude Code reads them, never written.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bashWords, claudeEntry, claudeOwnRules, codexOwnRules, sendOwnRules, tilde } from "../src/own-rules.ts";

const HOME = "/Users/dana";

describe("Claude Code's permission rules, as entries", () => {
  it("reads how a command starts from each way Claude Code writes it", () => {
    assert.deepEqual(bashWords("git:*"), ["git"]);
    assert.deepEqual(bashWords("npm run test:*"), ["npm", "run", "test"]);
    assert.deepEqual(bashWords("git push *"), ["git", "push"]);
    assert.deepEqual(bashWords("* --version"), ["*", "--version"]);
    assert.deepEqual(bashWords("ls"), ["ls"]);
    assert.equal(bashWords("*"), undefined);
    assert.equal(bashWords(undefined), undefined);
  });

  it("sorts each tool into reading, writing, the web, commands or another tool", () => {
    assert.deepEqual(claudeEntry("Bash(git:*)"), { kind: "command", name: "Bash", words: ["git"], raw: "Bash(git:*)" });
    assert.deepEqual(claudeEntry("Bash"), { kind: "command", name: "Bash", raw: "Bash" });
    assert.equal(claudeEntry("Read(./src/**)")?.kind, "read");
    assert.equal(claudeEntry("Grep")?.kind, "read");
    assert.equal(claudeEntry("MultiEdit")?.kind, "write");
    assert.equal(claudeEntry("WebFetch(domain:example.com)")?.kind, "web");
    assert.deepEqual(claudeEntry("mcp__github__create_issue"), {
      kind: "tool",
      name: "mcp__github__create_issue",
      raw: "mcp__github__create_issue",
    });
    assert.equal(claudeEntry("  "), undefined);
  });
});

describe("Claude Code's copy", () => {
  const user = {
    permissions: {
      allow: ["Read", "Bash(git:*)", "Bash(curl:*)", "WebFetch"],
      ask: ["Bash(git push:*)"],
      deny: ["Bash(rm:*)"],
      defaultMode: "auto",
    },
  };

  it("joins the person's lists and each agent folder's, every entry once, in the bridge's mode", () => {
    const copy = claudeOwnRules({
      userPath: `${HOME}/.claude/settings.json`,
      user,
      folders: [
        {
          path: `${HOME}/Chips/Agents/claude-code/nova/.claude/settings.local.json`,
          layer: { permissions: { allow: ["Bash(git:*)", "Edit"] } },
        },
      ],
      mode: "default",
      home: HOME,
    });
    assert.deepEqual(copy.read_from, [
      "~/.claude/settings.json",
      "~/Chips/Agents/claude-code/nova/.claude/settings.local.json",
    ]);
    assert.equal(copy.mode, "Default");
    assert.deepEqual(
      copy.runs.map((entry) => entry.raw),
      ["Read", "Bash(git:*)", "Bash(curl:*)", "WebFetch", "Edit"],
    );
    assert.deepEqual(copy.asks?.map((entry) => entry.words), [["git", "push"]]);
    assert.deepEqual(copy.refuses?.map((entry) => entry.words), [["rm"]]);
    assert.equal(
      copy.note,
      "Your own Claude Code reads the same file, so a change there changes both. Your own Claude Code runs in Auto mode; Chips puts each session in Default.",
    );
    assert.deepEqual(copy.ask_line, {
      entry: '"Bash({words}:*)"',
      line: '"ask": [{entries}]',
      where: "`permissions` in `~/.claude/settings.json`",
    });
    assert.equal(copy.everything, undefined);
  });

  it("says what a mode lets through: every edit in Accept edits, everything in Bypass", () => {
    const edits = claudeOwnRules({ userPath: `${HOME}/.claude/settings.json`, user: undefined, folders: [], mode: "acceptEdits", home: HOME });
    assert.deepEqual(
      edits.runs.map((entry) => [entry.kind, entry.name]),
      [
        ["write", "Edit"],
        ["write", "Write"],
        ["write", "MultiEdit"],
      ],
    );
    assert.deepEqual(edits.read_from, ["~/.claude/settings.json"]);
    const bypass = claudeOwnRules({ userPath: `${HOME}/.claude/settings.json`, user, folders: [], mode: "bypassPermissions", home: HOME });
    assert.equal(bypass.everything, true);
    assert.deepEqual(bypass.runs, []);
  });

  it("names at most eight places and two hundred entries", () => {
    const many = Array.from({ length: 250 }, (_, at) => `Bash(tool${at}:*)`);
    const folders = Array.from({ length: 12 }, (_, at) => ({ path: `${HOME}/a${at}/.claude/settings.json`, layer: {} }));
    const copy = claudeOwnRules({
      userPath: `${HOME}/.claude/settings.json`,
      user: { permissions: { allow: many } },
      folders,
      mode: "default",
      home: HOME,
    });
    assert.equal(copy.read_from.length, 8);
    assert.equal(copy.runs.length, 200);
    assert.equal(tilde("/elsewhere/settings.json", HOME), "/elsewhere/settings.json");
  });
});

describe("Codex's copy", () => {
  it("says what its mode lets through, each mode named as codex-acp names it", () => {
    const write = codexOwnRules("workspace-write");
    assert.equal(write.mode, "Workspace access");
    assert.deepEqual(write.runs, []);
    assert.match(write.note ?? "", /asks before the network/);
    assert.equal(codexOwnRules("agent-full-access").everything, true);
    assert.equal(codexOwnRules("agent-full-access").mode, "Full access");
    assert.equal(codexOwnRules("full-access").everything, true);
    assert.equal(codexOwnRules("read-only").mode, "Read-only");
    assert.equal(codexOwnRules("agent").mode, "Auto review");
    assert.match(codexOwnRules("agent").note ?? "", /asks only about one it finds risky/);
  });
});

describe("sending the copy", () => {
  it("sends where the connection takes it, and does nothing on an older SDK or a refusal", async () => {
    const copy = codexOwnRules("workspace-write");
    const sent: unknown[] = [];
    const settings = {
      ownRules(this: { tag: string }, body: unknown) {
        sent.push([this.tag, body]);
        return Promise.resolve({});
      },
      tag: "settings",
    };
    assert.equal(await sendOwnRules(settings, copy), true);
    assert.deepEqual(sent, [["settings", copy]]);
    assert.equal(await sendOwnRules({}, copy), false);
    assert.equal(await sendOwnRules({ ownRules: () => Promise.reject(new Error("refused")) }, copy), false);
  });
});

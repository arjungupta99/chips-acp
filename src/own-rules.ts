/**
 * What Claude Code's and Codex's own settings let through without asking (Chips ADR 0299), as a
 * copy for the harness's Permissions page in Chips. Read, never written: Chips decides nothing from
 * it, and only says it, naming the commands Chips would never let a rule allow.
 *
 * Claude Code: `permissions` in the person's `~/.claude/settings.json`, then each agent folder's
 * `.claude/settings.json` and `.claude/settings.local.json`; Claude Code joins their lists, so the
 * copy holds every entry once. The mode is the one the bridge puts each session in (`default`),
 * which beats the person's own `defaultMode`. Codex: the mode alone, since its own rules live in
 * its sandbox and its approval policy, which the mode sets.
 */

import { homedir } from "node:os";
import type { Layer } from "./claude-settings.js";
import type { KindMode } from "./kinds.js";
import type { OwnModes } from "./modes.js";

/** One thing the settings let through, ask about, or refuse, as Chips's `ownEntry` has it. */
export interface OwnEntry {
  readonly kind: "read" | "write" | "web" | "command" | "tool";
  readonly name: string;
  readonly words?: string[] | undefined;
  readonly raw?: string | undefined;
}

/** The copy, as Chips's `ownRules` has it (SDK 1.0.10's `OwnRules`). */
export interface OwnRules {
  readonly read_from: string[];
  readonly note?: string | undefined;
  readonly mode?: string | undefined;
  readonly everything?: boolean | undefined;
  /** The modes a person may pick in Chips (Chips ADR 0300), as `modes.ts` writes them. */
  readonly modes?: OwnModes | undefined;
  readonly runs: OwnEntry[];
  readonly asks?: OwnEntry[] | undefined;
  readonly refuses?: OwnEntry[] | undefined;
  readonly ask_line?: { readonly entry: string; readonly line: string; readonly where: string } | undefined;
}

/** The most entries one list carries, and the most places named. */
const MOST = 200;
const MOST_PLACES = 8;
const LONGEST_NAME = 120;
const LONGEST_RAW = 400;

const READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const WEB = new Set(["WebFetch", "WebSearch"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clip = (text: string, most: number) => (text.length > most ? text.slice(0, most) : text);

/**
 * The words a `Bash(…)` rule's commands start with: `git` for `Bash(git:*)` and `Bash(git *)`,
 * `* --version` for `Bash(* --version)`, `ls` for `Bash(ls)`. Nothing for `Bash` alone: any command.
 */
export function bashWords(inner: string | undefined): string[] | undefined {
  if (inner === undefined) return undefined;
  const pattern = inner.trim().replace(/:\*$/, "").replace(/\s+\*$/, "");
  if (pattern === "" || pattern === "*") return undefined;
  const words = pattern.split(/\s+/).map((word) => clip(word, LONGEST_NAME));
  return words.slice(0, 8);
}

/** One of Claude Code's permission rules, `Bash(git:*)`, `Read(./src/**)`, `mcp__github`, as an entry. */
export function claudeEntry(rule: string): OwnEntry | undefined {
  const said = /^\s*([^()\s]+)\s*(?:\((.*)\))?\s*$/s.exec(rule);
  const name = said?.[1];
  if (name === undefined) return undefined;
  const raw = clip(rule.trim(), LONGEST_RAW);
  const tool = clip(name, LONGEST_NAME);
  if (name === "Bash") {
    const words = bashWords(said?.[2]);
    return { kind: "command", name: tool, ...(words === undefined ? {} : { words }), raw };
  }
  const kind = READS.has(name) ? "read" : WRITES.has(name) ? "write" : WEB.has(name) ? "web" : "tool";
  return { kind, name: tool, raw };
}

/** Each layer's list under `permissions`, joined as Claude Code joins them, every entry once. */
function joined(layers: readonly Layer[], list: "allow" | "ask" | "deny"): OwnEntry[] {
  const seen = new Set<string>();
  const entries: OwnEntry[] = [];
  for (const layer of layers) {
    const permissions = layer["permissions"];
    const rules = isRecord(permissions) ? permissions[list] : undefined;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== "string" || seen.has(rule.trim())) continue;
      seen.add(rule.trim());
      const entry = claudeEntry(rule);
      if (entry !== undefined) entries.push(entry);
    }
  }
  return entries.slice(0, MOST);
}

/** The person's own `defaultMode`, where their settings say one. */
function ownDefaultMode(layer: Layer | undefined): string | undefined {
  const permissions = layer?.["permissions"];
  const mode = isRecord(permissions) ? permissions["defaultMode"] : undefined;
  return typeof mode === "string" && mode !== "" ? mode : undefined;
}

const CLAUDE_MODES: Readonly<Record<string, string>> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
  auto: "Auto",
};

/** A mode as Claude Code's own picker names it. */
export function claudeModeName(mode: string): string {
  return CLAUDE_MODES[mode] ?? mode;
}

/** `~/.claude/settings.json` for a path under the home folder. */
export function tilde(path: string, home: string = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A layer read from a file, and where. */
export interface PlacedLayer {
  readonly path: string;
  readonly layer: Layer;
}

/**
 * Claude Code's copy: the person's layer (`user`, at `userPath`, there or not), then each agent
 * folder's layers, and the mode the bridge's sessions run in.
 */
export function claudeOwnRules(options: {
  readonly userPath: string;
  readonly user: Layer | undefined;
  readonly folders: readonly PlacedLayer[];
  readonly mode: string;
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const layers = [...(options.user === undefined ? [] : [options.user]), ...options.folders.map((each) => each.layer)];
  const userPlace = tilde(options.userPath, home);
  const read_from = [userPlace, ...options.folders.map((each) => tilde(each.path, home))].slice(0, MOST_PLACES);
  const own = ownDefaultMode(options.user);
  const notes = [
    "Your own Claude Code reads the same file, so a change there changes both.",
    own !== undefined && own !== options.mode
      ? `Your own Claude Code runs in ${claudeModeName(own)} mode; Chips puts each session in ${claudeModeName(options.mode)}.`
      : undefined,
  ].filter((note): note is string => note !== undefined);
  const ask_line = {
    entry: '"Bash({words}:*)"',
    line: '"ask": [{entries}]',
    where: `\`permissions\` in \`${userPlace}\``,
  };
  if (options.mode === "bypassPermissions") {
    return { read_from, note: notes.join(" "), mode: claudeModeName(options.mode), everything: true, runs: [] };
  }
  const allowed = joined(layers, "allow");
  // Accept edits lets every edit through, whatever the lists say.
  const edits: OwnEntry[] =
    options.mode === "acceptEdits"
      ? ["Edit", "Write", "MultiEdit"]
          .filter((name) => !allowed.some((entry) => entry.name === name))
          .map((name) => ({ kind: "write", name, raw: "acceptEdits" }))
      : [];
  return {
    read_from,
    note: notes.join(" "),
    mode: claudeModeName(options.mode),
    runs: [...allowed, ...edits].slice(0, MOST),
    asks: joined(layers, "ask"),
    refuses: joined(layers, "deny"),
    ask_line,
  };
}

/** Codex's modes as codex-acp names them, and the names of its sandboxes before it. */
const CODEX_MODES: Readonly<Record<string, string>> = {
  "read-only": "Read-only",
  "workspace-write": "Workspace access",
  agent: "Auto review",
  "agent-full-access": "Full access",
  "full-access": "Full access",
  "danger-full-access": "Full access",
};

/** Codex's copy: what the mode the bridge's sessions run in lets through. */
export function codexOwnRules(mode: string): OwnRules {
  const read_from = ["the mode Chips starts each Codex session in"];
  const name = CODEX_MODES[mode] ?? mode;
  if (mode === "agent-full-access" || mode === "full-access" || mode === "danger-full-access") {
    return {
      read_from,
      mode: name,
      everything: true,
      note: "Codex runs with full access, so it never asks.",
      runs: [],
    };
  }
  if (mode === "read-only") {
    return {
      read_from,
      mode: name,
      note: "Codex reads on its own and changes nothing without a yes: it asks first, or says it can't.",
      runs: [],
    };
  }
  if (mode === "agent") {
    return {
      read_from,
      mode: name,
      note: "Codex edits files and runs commands inside the agent's folder in its own sandbox, judges each step itself, and asks only about one it finds risky.",
      runs: [],
    };
  }
  return {
    read_from,
    mode: name,
    note: "Codex edits files and runs commands inside the agent's folder in its own sandbox, and asks before the network or anything outside that folder.",
    runs: [],
  };
}

/**
 * The copy for a kind this bridge knows by name only (Chips ADR 0301): the mode its sessions run in,
 * said in the kind's own words. What the agent's settings let through beside it, the bridge doesn't
 * read, so it lists nothing it runs.
 */
export function modeOwnRules(name: string, running: string, mode: KindMode | undefined): OwnRules {
  const read_from = [`the mode Chips starts each ${name} session in`];
  if (mode === undefined) return { read_from, mode: running, runs: [] };
  return { read_from, mode: mode.name, ...(mode.everything === true ? { everything: true } : {}), note: mode.words, runs: [] };
}

/**
 * Copilot's copy (Chips ADR 0301): its Allow all, as each session it opens says it (the option of
 * category `permissions`). Copilot keeps no rules on disk: what it lets through beside that is a yes
 * given in a session, for that session.
 */
export function copilotOwnRules(allowAll: string | undefined): OwnRules {
  const read_from = ["Copilot's Allow all, as its sessions say it"];
  if (allowAll === "on") {
    return { read_from, mode: "Allow all", everything: true, note: "Copilot approves every tool, path and URL request without asking.", runs: [] };
  }
  return { read_from, mode: "Asks first", note: "Copilot asks before it uses a tool, reaches a path or fetches a URL.", runs: [] };
}

/** A section of a TOML file, from its `[name]` to the next header. */
function tomlSection(toml: string, name: string): string {
  let inside = false;
  const lines: string[] = [];
  for (const line of toml.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      inside = header[1]?.trim() === name;
      continue;
    }
    if (inside) lines.push(line);
  }
  return lines.join("\n");
}

const tomlString = (section: string, key: string): string | undefined =>
  new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1];

const tomlTrue = (section: string, key: string): boolean => new RegExp(`^\\s*${key}\\s*=\\s*true\\b`, "m").test(section);

/** Grok's own mode, from `[ui]` in its config: `permission_mode`, else the older `approval_mode` and `yolo`. */
export function grokModeOf(toml: string | undefined): "ask" | "auto" | "always-approve" {
  const ui = tomlSection(toml ?? "", "ui");
  const said = tomlString(ui, "permission_mode") ?? tomlString(ui, "approval_mode");
  if (said === "auto" || said === "always-approve" || said === "ask") return said;
  return tomlTrue(ui, "yolo") ? "always-approve" : "ask";
}

const GROK_MODES = {
  ask: { name: "Ask", note: "Grok asks before anything its rules don't allow." },
  auto: { name: "Auto", note: "Grok's own check lets safe steps through and asks about risky ones." },
  "always-approve": { name: "Always-approve", note: "Grok approves every step without asking: only deny rules and hooks stop one." },
} as const;

/** One of Grok's own rules, `{ action = "allow", tool = "bash", pattern = "git *" }`, as an entry. */
function grokEntry(tool: string, pattern: string | undefined, raw: string): OwnEntry {
  const name = clip(tool, LONGEST_NAME);
  const lower = tool.toLowerCase();
  if (lower === "bash") {
    const words = bashWords(pattern);
    return { kind: "command", name, ...(words === undefined ? {} : { words }), raw: clip(raw, LONGEST_RAW) };
  }
  const kind = lower === "read" || lower === "grep" ? "read" : lower === "edit" ? "write" : lower.startsWith("web") ? "web" : "tool";
  return { kind, name, raw: clip(raw, LONGEST_RAW) };
}

/** Grok's own rules, from `[permission] rules` in its config, by what each does. */
export function grokRulesOf(toml: string | undefined): Record<"allow" | "ask" | "deny", OwnEntry[]> {
  const rules = { allow: [] as OwnEntry[], ask: [] as OwnEntry[], deny: [] as OwnEntry[] };
  const section = tomlSection(toml ?? "", "permission");
  for (const table of section.matchAll(/\{([^{}]*)\}/g)) {
    const body = table[1] ?? "";
    const field = (key: string) => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(body)?.[1];
    const action = field("action");
    const tool = field("tool");
    if ((action === "allow" || action === "ask" || action === "deny") && tool !== undefined) {
      rules[action].push(grokEntry(tool, field("pattern"), `{${body.trim()}}`));
    }
  }
  return { allow: rules.allow.slice(0, MOST), ask: rules.ask.slice(0, MOST), deny: rules.deny.slice(0, MOST) };
}

/**
 * Grok's copy (Chips ADR 0301): its mode and rules from `~/.grok/config.toml`, and the permission
 * rules it takes from Claude Code's settings files, which it follows too. Read, never written.
 */
export function grokOwnRules(options: {
  readonly configPath: string;
  readonly config: string | undefined;
  readonly claude: readonly PlacedLayer[];
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const mode = grokModeOf(options.config);
  const own = grokRulesOf(options.config);
  const layers = options.claude.map((each) => each.layer);
  const borrowed = { allow: joined(layers, "allow"), ask: joined(layers, "ask"), deny: joined(layers, "deny") };
  const withClaude = borrowed.allow.length + borrowed.ask.length + borrowed.deny.length > 0;
  const read_from = [tilde(options.configPath, home), ...(withClaude ? options.claude.map((each) => tilde(each.path, home)) : [])].slice(0, MOST_PLACES);
  const note = [GROK_MODES[mode].note, withClaude ? "It follows your Claude Code permission rules too, as listed here." : undefined]
    .filter((line): line is string => line !== undefined)
    .join(" ");
  if (mode === "always-approve") return { read_from, mode: GROK_MODES[mode].name, everything: true, note, runs: [] };
  return {
    read_from,
    mode: GROK_MODES[mode].name,
    note,
    runs: [...own.allow, ...borrowed.allow].slice(0, MOST),
    asks: [...own.ask, ...borrowed.ask].slice(0, MOST),
    refuses: [...own.deny, ...borrowed.deny].slice(0, MOST),
  };
}

/**
 * Send the copy where the connection takes it: SDK 1.0.10's `settings.ownRules`. An older SDK has
 * no such method and an older Chips refuses it; either way nothing else changes.
 */
export async function sendOwnRules(settings: unknown, copy: OwnRules): Promise<boolean> {
  const send = (settings as { ownRules?: (copy: unknown) => Promise<unknown> } | undefined)?.ownRules;
  if (typeof send !== "function") return false;
  try {
    await send.call(settings, copy);
    return true;
  } catch {
    return false;
  }
}

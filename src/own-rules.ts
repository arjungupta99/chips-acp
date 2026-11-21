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

/** What Copilot keeps on disk beside its Allow all: the yeses it saved per folder, and its URL rules. */
export interface CopilotSaved {
  /** `permissions-config.json`, where Copilot saves each "don't ask again" by the folder it ran in. */
  readonly configPath: string;
  readonly config: Layer | undefined;
  /** `settings.json`, whose `allowedUrls` and `deniedUrls` hold for every folder. */
  readonly settingsPath: string;
  readonly settings: Layer | undefined;
  /** The agents' folders: Copilot saves a yes under the folder a session ran in. */
  readonly folders: readonly string[];
  readonly home?: string | undefined;
}

/** One of Copilot's saved yeses (`tool_approvals[]`) as entries: one per command it names. */
function copilotEntries(approval: unknown): OwnEntry[] {
  if (!isRecord(approval) || typeof approval["kind"] !== "string") return [];
  const kind = approval["kind"];
  if (kind === "commands") {
    const said = approval["commandIdentifiers"];
    return (Array.isArray(said) ? said : [])
      .filter((each): each is string => typeof each === "string" && each.trim() !== "")
      .map((each) => {
        const words = bashWords(each.trim());
        return { kind: "command" as const, name: "shell", ...(words === undefined ? {} : { words }), raw: clip(each.trim(), LONGEST_RAW) };
      });
  }
  if (kind === "read" || kind === "write") return [{ kind, name: kind, raw: kind }];
  if (kind === "mcp") {
    const server = typeof approval["serverName"] === "string" ? approval["serverName"] : "";
    const tool = typeof approval["toolName"] === "string" ? approval["toolName"] : "*";
    return server === "" ? [] : [{ kind: "tool", name: clip(`${server}(${tool})`, LONGEST_NAME), raw: clip(`${server}(${tool})`, LONGEST_RAW) }];
  }
  const tool = typeof approval["toolName"] === "string" ? approval["toolName"] : typeof approval["extensionName"] === "string" ? approval["extensionName"] : undefined;
  const label = tool === undefined ? kind : `${kind}(${tool})`;
  return [{ kind: "tool", name: clip(label, LONGEST_NAME), raw: clip(label, LONGEST_RAW) }];
}

/** URL rules from Copilot's settings, as entries. */
function urlEntries(said: unknown): OwnEntry[] {
  return (Array.isArray(said) ? said : [])
    .filter((each): each is string => typeof each === "string" && each.trim() !== "")
    .map((each) => ({ kind: "web" as const, name: "url", raw: clip(each.trim(), LONGEST_RAW) }));
}

/** Entries once each, by what they say, two hundred at most. */
function once(entries: readonly OwnEntry[]): OwnEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.kind} ${entry.name} ${entry.raw ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MOST);
}

/**
 * Copilot's copy (Chips ADR 0301): its Allow all, as each session it opens says it (the option of
 * category `permissions`), and what it keeps on disk: each "don't ask again" it saved for one of
 * the agents' folders (`~/.copilot/permissions-config.json`), and the URLs its settings always
 * allow or deny. Read, never written.
 */
export function copilotOwnRules(allowAll: string | undefined, saved?: CopilotSaved): OwnRules {
  const home = saved?.home ?? homedir();
  const files = saved === undefined ? [] : [saved.config === undefined ? undefined : saved.configPath, saved.settings === undefined ? undefined : saved.settingsPath];
  const read_from = ["Copilot's Allow all, as its sessions say it", ...files.filter((path): path is string => path !== undefined).map((path) => tilde(path, home))];
  if (allowAll === "on") {
    return { read_from, mode: "Allow all", everything: true, note: "Copilot approves every tool, path and URL request without asking.", runs: [] };
  }
  const locations = isRecord(saved?.config?.["locations"]) ? (saved?.config?.["locations"] as Layer) : {};
  const folders = saved?.folders ?? [];
  const approvals = Object.entries(locations)
    .filter(([place]) => folders.some((folder) => folder === place || folder.startsWith(`${place}/`)))
    .flatMap(([, held]) => (isRecord(held) && Array.isArray(held["tool_approvals"]) ? held["tool_approvals"] : []));
  const runs = once([...approvals.flatMap(copilotEntries), ...urlEntries(saved?.settings?.["allowedUrls"])]);
  const refuses = once(urlEntries(saved?.settings?.["deniedUrls"]));
  const note = [
    "Copilot asks before it uses a tool, reaches a path or fetches a URL.",
    runs.length > 0 ? "It runs on its own what it was told to keep allowing in these agents' folders." : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join(" ");
  return { read_from, mode: "Asks first", note, runs, ...(refuses.length > 0 ? { refuses } : {}) };
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

/** The modes a Grok session can run in. */
export type GrokMode = "ask" | "accept-edits" | "auto" | "dont-ask" | "always-approve";

/** Grok's own mode, from `[ui]` in its config: `permission_mode`, else the older `approval_mode` and `yolo`. */
export function grokModeOf(toml: string | undefined): GrokMode {
  const ui = tomlSection(toml ?? "", "ui");
  const said = tomlString(ui, "permission_mode") ?? tomlString(ui, "approval_mode");
  if (said === "auto" || said === "always-approve" || said === "ask") return said;
  return tomlTrue(ui, "yolo") ? "always-approve" : "ask";
}

/**
 * Claude Code's `defaultMode` as Grok takes it. Grok accepts `plan` there but doesn't go into plan
 * mode for it, and its ACP sessions ignore plan anyway, so plan is Ask.
 */
const GROK_FROM_CLAUDE: Readonly<Record<string, GrokMode>> = {
  default: "ask",
  plan: "ask",
  acceptEdits: "accept-edits",
  auto: "auto",
  dontAsk: "dont-ask",
  bypassPermissions: "always-approve",
};

/**
 * The mode Grok's sessions run in, and the file that says it. A Claude Code `defaultMode` comes
 * first, the most specific file's (local over shared, an agent folder's over the person's): Grok
 * 1.0.89 was seen running in Auto from `~/.claude/settings.json` while its own config said ask
 * (20 November 2026). Then Grok's own `[ui]` setting, then Ask.
 */
export function grokModeFrom(
  config: { readonly path: string; readonly toml: string | undefined },
  claude: readonly PlacedLayer[],
): { readonly mode: GrokMode; readonly from?: string } {
  for (const each of [...claude].reverse()) {
    const said = ownDefaultMode(each.layer);
    const mode = said === undefined ? undefined : GROK_FROM_CLAUDE[said];
    if (mode !== undefined) return { mode, from: each.path };
  }
  const ui = tomlSection(config.toml ?? "", "ui");
  const said = tomlString(ui, "permission_mode") ?? tomlString(ui, "approval_mode") ?? (tomlTrue(ui, "yolo") ? "yolo" : undefined);
  return said === undefined ? { mode: "ask" } : { mode: grokModeOf(config.toml), from: config.path };
}

const GROK_MODES: Readonly<Record<GrokMode, { readonly name: string; readonly note: string }>> = {
  ask: { name: "Ask", note: "Grok asks before anything but read-only steps and what its rules allow." },
  "accept-edits": { name: "Accept edits", note: "Grok edits files without asking, and asks before commands its rules don't allow." },
  auto: { name: "Auto", note: "Grok's own check lets safe steps through, and blocks or asks about the rest." },
  "dont-ask": { name: "Don't ask", note: "Grok runs only read-only steps and what its rules allow, and refuses the rest without asking." },
  "always-approve": { name: "Always-approve", note: "Grok approves every step without asking: only deny rules and hooks stop one." },
};

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
 * Grok's copy (Chips ADR 0301): its mode, from Claude Code's `defaultMode` or its own config, its
 * rules from `~/.grok/config.toml`, and the permission rules it takes from Claude Code's settings
 * files, which it follows too. Read, never written.
 */
export function grokOwnRules(options: {
  readonly configPath: string;
  readonly config: string | undefined;
  readonly claude: readonly PlacedLayer[];
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const { mode, from } = grokModeFrom({ path: options.configPath, toml: options.config }, options.claude);
  const own = grokRulesOf(options.config);
  const layers = options.claude.map((each) => each.layer);
  const borrowed = { allow: joined(layers, "allow"), ask: joined(layers, "ask"), deny: joined(layers, "deny") };
  const withClaude = borrowed.allow.length + borrowed.ask.length + borrowed.deny.length > 0;
  const fromClaude = from !== undefined && from !== options.configPath;
  const read_from = [
    tilde(options.configPath, home),
    ...options.claude.filter((each) => withClaude || each.path === from).map((each) => tilde(each.path, home)),
  ].slice(0, MOST_PLACES);
  const note = [
    GROK_MODES[mode].note,
    fromClaude ? `Grok takes this mode from defaultMode in ${tilde(from, home)}, ahead of its own config.` : undefined,
    withClaude ? "It follows your Claude Code permission rules too, as listed here." : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join(" ");
  if (mode === "always-approve") return { read_from, mode: GROK_MODES[mode].name, everything: true, note, runs: [] };
  const allowed = [...own.allow, ...borrowed.allow];
  // Accept edits lets every edit through, whatever the rules say.
  const edits: OwnEntry[] =
    mode === "accept-edits" && !allowed.some((entry) => entry.kind === "write") ? [{ kind: "write", name: "Edit", raw: "acceptEdits" }] : [];
  return {
    read_from,
    mode: GROK_MODES[mode].name,
    note,
    runs: [...allowed, ...edits].slice(0, MOST),
    asks: [...own.ask, ...borrowed.ask].slice(0, MOST),
    refuses: [...own.deny, ...borrowed.deny].slice(0, MOST),
  };
}

/** A rule written `action(target)`, as Antigravity and Cursor write theirs: its action and target. */
function actionRule(rule: string): { readonly action: string; readonly target?: string } | undefined {
  const said = /^\s*([^()\s]+)\s*(?:\((.*)\))?\s*$/s.exec(rule);
  const action = said?.[1];
  if (action === undefined) return undefined;
  const target = said?.[2]?.trim();
  return target === undefined || target === "" ? { action } : { action, target };
}

/** A list of rules, each once, as entries. */
function ruleList(rules: unknown, entry: (rule: string) => OwnEntry | undefined): OwnEntry[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const entries: OwnEntry[] = [];
  for (const rule of rules) {
    if (typeof rule !== "string" || rule.trim() === "" || seen.has(rule.trim())) continue;
    seen.add(rule.trim());
    const made = entry(rule.trim());
    if (made !== undefined) entries.push(made);
  }
  return entries.slice(0, MOST);
}

/** One of Antigravity's rules, `command(git)`, `write_file(src/)`, `read_url(google.com)`, as an entry. */
export function antigravityEntry(rule: string): OwnEntry | undefined {
  const parts = actionRule(rule);
  if (parts === undefined) return undefined;
  const name = clip(parts.action, LONGEST_NAME);
  const raw = clip(rule, LONGEST_RAW);
  switch (parts.action) {
    case "command":
    case "unsandboxed": {
      const words = parts.target?.startsWith("regex:") === true ? undefined : bashWords(parts.target);
      return { kind: "command", name, ...(words === undefined ? {} : { words }), raw };
    }
    case "read_file":
      return { kind: "read", name, raw };
    case "write_file":
      return { kind: "write", name, raw };
    case "read_url":
    case "execute_url":
      return { kind: "web", name, raw };
    default:
      return { kind: "tool", name, raw };
  }
}

/** Antigravity's `toolPermission`, where it says more than its mode does. */
const ANTIGRAVITY_TOOL_PERMISSION: Readonly<Record<string, string>> = {
  strict: "Its tool permission is Strict: it asks before every command, whatever the mode.",
  "proceed-in-sandbox": "Its tool permission is Proceed in sandbox: it runs commands in its sandbox without asking, and asks before any outside it.",
};

/**
 * Antigravity's copy (Chips ADR 0301): the mode Chips starts each session in, and its own rules,
 * `permissions` in `~/.gemini/antigravity-cli/settings.json` (deny over ask over allow), with its
 * `toolPermission` where that says more. Its project and shared scopes aren't files the bridge can
 * read, so they aren't listed. Read, never written.
 */
export function antigravityOwnRules(options: {
  readonly settingsPath: string;
  readonly settings: Layer | undefined;
  readonly running: string;
  readonly mode: KindMode | undefined;
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const read_from = ["the mode Chips starts each Antigravity session in", tilde(options.settingsPath, home)];
  const tool = options.settings?.["toolPermission"];
  const name = options.mode?.name ?? options.running;
  if (tool === "always-proceed" || options.mode?.everything === true) {
    const note = tool === "always-proceed" ? "Its tool permission is Always proceed: it approves every step without asking." : options.mode?.words;
    return { read_from, mode: name, everything: true, ...(note === undefined ? {} : { note }), runs: [] };
  }
  const permissions = options.settings?.["permissions"];
  const lists = isRecord(permissions) ? permissions : {};
  const note = [options.mode?.words, typeof tool === "string" ? ANTIGRAVITY_TOOL_PERMISSION[tool] : undefined]
    .filter((line): line is string => line !== undefined)
    .join(" ");
  return {
    read_from,
    mode: name,
    ...(note === "" ? {} : { note }),
    runs: ruleList(lists["allow"], antigravityEntry),
    asks: ruleList(lists["ask"], antigravityEntry),
    refuses: ruleList(lists["deny"], antigravityEntry),
  };
}

/** Goose's own lists, `user` in its `permission.yaml`: each tool it always allows, asks before, never allows. */
export function goosePermissionsOf(yaml: string | undefined): Record<"always_allow" | "ask_before" | "never_allow", string[]> {
  const lists = { always_allow: [] as string[], ask_before: [] as string[], never_allow: [] as string[] };
  let section: string | undefined;
  let list: keyof typeof lists | undefined;
  const unquoted = (text: string) => text.trim().replace(/^(['"])(.*)\1$/, "$2");
  for (const line of (yaml ?? "").split("\n")) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const top = /^([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(line);
    if (top !== null) {
      section = top[1];
      list = undefined;
      continue;
    }
    if (section !== "user") continue;
    const key = /^\s+(always_allow|ask_before|never_allow):\s*(.*)$/.exec(line);
    if (key !== null) {
      list = key[1] as keyof typeof lists;
      const inline = /^\[(.*)\]\s*(?:#.*)?$/.exec(key[2]?.trim() ?? "");
      if (inline !== null) {
        for (const each of (inline[1] ?? "").split(",")) if (unquoted(each) !== "") lists[list].push(unquoted(each));
        list = undefined;
      }
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (item !== null && list !== undefined && unquoted(item[1] ?? "") !== "") lists[list].push(unquoted(item[1] ?? ""));
  }
  return lists;
}

/** One of Goose's tools, `developer__shell`, as an entry: its shell is any command. */
function gooseEntry(tool: string): OwnEntry {
  const name = clip(tool, LONGEST_NAME);
  return /(^|__)shell$/.test(tool) ? { kind: "command", name, raw: name } : { kind: "tool", name, raw: name };
}

/**
 * Goose's copy (Chips ADR 0301): the mode Chips starts each session in, and its own lists, `user`
 * in `permission.yaml` in its config folder: the tools it always allows, asks before, and never
 * allows. Read, never written.
 */
export function gooseOwnRules(options: {
  readonly permissionPath: string;
  readonly yaml: string | undefined;
  readonly running: string;
  readonly mode: KindMode | undefined;
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const read_from = ["the mode Chips starts each Goose session in", tilde(options.permissionPath, home)];
  const name = options.mode?.name ?? options.running;
  const note = options.mode?.words;
  if (options.mode?.everything === true) return { read_from, mode: name, everything: true, ...(note === undefined ? {} : { note }), runs: [] };
  const lists = goosePermissionsOf(options.yaml);
  return {
    read_from,
    mode: name,
    ...(note === undefined ? {} : { note }),
    runs: once(lists.always_allow.map(gooseEntry)),
    asks: once(lists.ask_before.map(gooseEntry)),
    refuses: once(lists.never_allow.map(gooseEntry)),
  };
}

/** One of Cursor's rules, `Shell(git)`, `Read(src/**)`, `WebFetch(docs.github.com)`, as an entry. */
export function cursorEntry(rule: string): OwnEntry | undefined {
  const parts = actionRule(rule);
  if (parts === undefined) return undefined;
  const name = clip(parts.action, LONGEST_NAME);
  const raw = clip(rule, LONGEST_RAW);
  switch (parts.action) {
    case "Shell": {
      const words = bashWords(parts.target);
      return { kind: "command", name, ...(words === undefined ? {} : { words }), raw };
    }
    case "Read":
      return { kind: "read", name, raw };
    case "Write":
      return { kind: "write", name, raw };
    case "WebFetch":
      return { kind: "web", name, raw };
    default:
      return { kind: "tool", name, raw };
  }
}

const CURSOR_MODES: Readonly<Record<string, { readonly name: string; readonly note: string; readonly everything?: true }>> = {
  allowlist: { name: "Allowlist", note: "Cursor runs what its allow list allows, and asks before the rest." },
  "auto-review": {
    name: "Auto-review",
    note: "Cursor runs what its allow list allows, runs other commands in its sandbox where it can, and its own check decides the rest.",
  },
  unrestricted: { name: "Run everything", note: "Cursor runs every step without asking.", everything: true },
};

/**
 * Cursor's copy (Chips ADR 0301): its `approvalMode` and `permissions` in `~/.cursor/cli-config.json`,
 * with each agent folder's `.cursor/cli.json` rules beside them (deny over allow). Read, never
 * written.
 */
export function cursorOwnRules(options: {
  readonly configPath: string;
  readonly config: Layer | undefined;
  readonly folders: readonly PlacedLayer[];
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const read_from = [tilde(options.configPath, home), ...options.folders.map((each) => tilde(each.path, home))].slice(0, MOST_PLACES);
  const said = options.config?.["approvalMode"];
  const mode = typeof said === "string" ? CURSOR_MODES[said] : undefined;
  if (mode?.everything === true) return { read_from, mode: mode.name, everything: true, note: mode.note, runs: [] };
  const layers = [...(options.config === undefined ? [] : [options.config]), ...options.folders.map((each) => each.layer)];
  const listed = (key: "allow" | "deny") =>
    once(layers.flatMap((layer) => ruleList(isRecord(layer["permissions"]) ? (layer["permissions"] as Layer)[key] : undefined, cursorEntry)));
  return {
    read_from,
    mode: mode?.name ?? "Cursor's own",
    note: mode?.note ?? "Cursor asks as its own Run Mode says: Auto-review, Allowlist or Run everything.",
    runs: listed("allow"),
    refuses: listed("deny"),
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

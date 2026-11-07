/**
 * An install from before 1.0.13 brought across to `~/Chips` (Chips ADR 0283), once, by the kind
 * that starts: its config and what it keeps from `~/.chips-acp`, its agents' folders from
 * `~/chips-acp/<kind>`, the folder paths its state saved, and Claude Code's own store for each folder
 * that moved, which holds the folder's conversations and its memory. Codex picks a conversation up
 * by its id in whatever folder it is given, so it needs nothing more.
 *
 * Nothing is copied and deleted: a folder is renamed, or, where something is at the new place already,
 * what isn't there yet is moved in and a clash is left where it was, said in the log. A rename that
 * fails leaves the old place in use (`places.ts` reads a path where it is). Each step looks at what is
 * on disk, so a start that stops halfway finishes on the next, and a start with nothing to move does
 * nothing. Two kinds starting at once move only their own files.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fromHome, inside, nowAt, type Places, placesOf } from "./places.js";
import { readConfig } from "./setup.js";

type Log = (line: string) => void;

const there = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isFolder = (path: string) => lstatSync(path).isDirectory();

/** `~` for the home in a path, as a person reads it. */
const shown = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * `from` moved to `to`: renamed where nothing is at `to`; else, both folders, each entry `to` hasn't
 * got moved in, and `from` removed once it is empty. Anything else is left where it is and said.
 */
export function merge(from: string, to: string, log: Log, home: string = homedir(), quiet = false): void {
  if (!there(from)) return;
  try {
    if (!there(to)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      if (!quiet) log(`moved ${shown(from, home)} to ${shown(to, home)}`);
      return;
    }
    if (!isFolder(from) || !isFolder(to)) {
      log(`${shown(from, home)} was left where it is: ${shown(to, home)} is there already`);
      return;
    }
    for (const entry of readdirSync(from)) merge(join(from, entry), join(to, entry), log, home, true);
    if (readdirSync(from).length === 0) rmdirSync(from);
    if (!quiet) log(`moved what was in ${shown(from, home)} into ${shown(to, home)}`);
  } catch (error) {
    log(`${shown(from, home)} couldn't be moved to ${shown(to, home)}, so it is used where it is: ${(error as Error).message}`);
  }
}

/** A folder removed when nothing is left in it. */
function removeIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Not there, or another kind's files still are.
  }
}

/**
 * Where Claude Code keeps a folder's conversations and memory: `~/.claude/projects/` (or
 * `CLAUDE_CONFIG_DIR`'s), named by the folder's path with each character but a letter or digit a
 * dash. A name past 200 characters Claude Code shortens with a hash of its own, so that one isn't
 * found here.
 */
export function claudeStoreOf(folder: string, env: NodeJS.ProcessEnv, home: string = homedir()): string | undefined {
  const name = folder.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length > 200) return undefined;
  return join(env["CLAUDE_CONFIG_DIR"] ? resolve(fromHome(env["CLAUDE_CONFIG_DIR"], home)) : join(home, ".claude"), "projects", name);
}

/** The folder a path names before the move and after it, where it is one of the agents' places. */
function pairOf(path: string, places: Places): { readonly old: string; readonly now: string } | undefined {
  const old = inside(places.oldAgents, path);
  if (old !== undefined) return { old: path, now: join(places.agents, old) };
  const now = inside(places.agents, path);
  return now === undefined ? undefined : { old: join(places.oldAgents, now), now: path };
}

/** A JSON file written whole, readable by the person alone, so a stop halfway leaves the old one. */
function writeJson(path: string, value: unknown): void {
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof read === "object" && read !== null ? (read as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The kind whose config goes at `configPath` (`configTargetOf`) brought across from before 1.0.13. */
export function moveOld(configPath: string, log: Log, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): void {
  const places = placesOf(home);
  const keptIn = join(dirname(configPath), basename(configPath, ".json"));

  // The config and what the kind keeps, where its config is one of the settings.
  const name = inside(places.settings, configPath);
  if (name !== undefined) {
    mkdirSync(dirname(dirname(places.settings)), { recursive: true });
    mkdirSync(places.settings, { recursive: true, mode: 0o700 });
    merge(join(places.oldSettings, name), configPath, log, home);
    merge(join(places.oldSettings, name.replace(/\.json$/, "")), keptIn, log, home);
  }

  let roots: string[];
  let kindEnv: Record<string, string> | undefined;
  try {
    const kind = readConfig(configPath);
    roots = [kind.folders, kind.folder].filter((root): root is string => root !== undefined);
    kindEnv = kind.env;
  } catch {
    // No config to read, which the start says as it always has.
    return;
  }

  // The agents' folders.
  const pairs = roots.map((root) => pairOf(root, places)).filter((pair) => pair !== undefined);
  for (const { old, now } of pairs) merge(old, now, log, home);

  // The config's own words, where it named a folder in the old place.
  const config = readJson(configPath);
  if (config !== undefined) {
    let changed = false;
    for (const key of ["folders", "folder"]) {
      const said = config[key];
      if (typeof said !== "string") continue;
      const path = resolve(fromHome(said, home));
      const moved = nowAt(path, places.oldAgents, places.agents);
      if (moved === path) continue;
      config[key] = `~/${moved.slice(home.length + 1)}`;
      changed = true;
    }
    if (changed) writeJson(configPath, config);
  }

  // The folder each agent's sessions work in, as the state saved it.
  const statePath = join(keptIn, "state.json");
  const state = readJson(statePath);
  const agents = state?.["agents"];
  if (state !== undefined && typeof agents === "object" && agents !== null) {
    let changed = false;
    for (const record of Object.values(agents as Record<string, Record<string, unknown>>)) {
      const folder = record["folder"];
      if (typeof folder !== "string") continue;
      const moved = nowAt(folder, places.oldAgents, places.agents);
      if (moved === folder) continue;
      record["folder"] = moved;
      changed = true;
    }
    if (changed) writeJson(statePath, state);
  }

  // Claude Code's store for each folder that moved: the kind's own, and each agent's in it.
  const storeEnv = { ...env, ...kindEnv };
  for (const { old, now } of pairs) {
    if (there(old) || !there(now)) continue;
    const folders = [{ old, now }];
    for (const entry of readdirSync(now)) {
      if (isFolder(join(now, entry))) folders.push({ old: join(old, entry), now: join(now, entry) });
    }
    for (const folder of folders) {
      const from = claudeStoreOf(folder.old, storeEnv, home);
      const to = claudeStoreOf(folder.now, storeEnv, home);
      if (from !== undefined && to !== undefined && !there(folder.old)) merge(from, to, log, home);
    }
  }

  removeIfEmpty(places.oldSettings);
  removeIfEmpty(places.oldAgents);
}

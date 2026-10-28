/**
 * What Claude Code's own settings say about one of this harness's agents, read as Claude Code reads
 * them and never written: the person's (`~/.claude/settings.json`), then the agent's folder's
 * (`.claude/settings.json`, then `.claude/settings.local.json`), each one over those before it.
 * The bridge's own settings for a session go in its `_meta` and are a layer over all of these.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Layer = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Layer =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readLayer(path: string): Layer | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(read) ? read : undefined;
  } catch {
    return undefined;
  }
}

/** The layers that hold for an agent working in `folder`, lowest first. */
export function settingsLayers(claudeHome: string, folder: string): Layer[] {
  return [
    join(claudeHome, "settings.json"),
    join(folder, ".claude", "settings.json"),
    join(folder, ".claude", "settings.local.json"),
  ].flatMap((path): Layer[] => {
    const layer = readLayer(path);
    return layer === undefined ? [] : [layer];
  });
}

/** The last word the layers have on a setting, where any has one. */
function lastSaid(layers: readonly Layer[], key: string): unknown {
  return layers.findLast((layer) => layer[key] !== undefined)?.[key];
}

/** Whether Claude Code keeps a memory for the agent (`autoMemoryEnabled`): yes unless said. */
export function memoryOn(layers: readonly Layer[]): boolean {
  return lastSaid(layers, "autoMemoryEnabled") !== false;
}

/** Whether Claude Code compacts on its own (`autoCompactEnabled`): yes unless said. */
export function autoCompactOn(layers: readonly Layer[]): boolean {
  return lastSaid(layers, "autoCompactEnabled") !== false;
}

/** A model's name as Claude Code keys its settings: without a date or `[1m]`. */
export function canonicalModel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * The auto-compact window the settings give a model, in tokens, resolved as Claude Code 2.1
 * resolves it: in one layer, `modelSettings[model].autoCompactWindow` over its top-level
 * `autoCompactWindow`; a later layer's top-level one over everything before it. Nothing where
 * no layer says, or where one says `auto`.
 */
export function autoCompactWindowOf(layers: readonly Layer[], model: string | undefined): number | undefined {
  let top: unknown;
  let byModel: Record<string, unknown> = {};
  for (const layer of layers) {
    const mine: Record<string, unknown> = {};
    const models = layer["modelSettings"];
    if (isRecord(models)) {
      for (const [name, value] of Object.entries(models)) {
        if (!isRecord(value) || value["autoCompactWindow"] === undefined) continue;
        const key = canonicalModel(name);
        if (name === key || !(key in mine)) mine[key] = value["autoCompactWindow"];
      }
    }
    if (layer["autoCompactWindow"] === undefined) byModel = { ...byModel, ...mine };
    else {
      top = layer["autoCompactWindow"];
      byModel = mine;
    }
  }
  const key = model === undefined ? undefined : canonicalModel(model);
  const chosen = key !== undefined && key in byModel ? byModel[key] : top;
  return typeof chosen === "number" && Number.isFinite(chosen) && chosen > 0 ? chosen : undefined;
}

/** `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which beats every setting: tokens, as `600000` or `600k`. */
export function autoCompactWindowFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const said = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] ?? "");
  if (said === null) return undefined;
  const scale = { "": 1, k: 1000, m: 1_000_000 }[(said[2] ?? "").toLowerCase()] ?? 1;
  const tokens = Math.round(Number(said[1]) * scale);
  return tokens > 0 ? tokens : undefined;
}

/**
 * Where Claude Code keeps an agent's memory: `projects/<its folder, each sign but a letter or a
 * digit a dash>/memory/MEMORY.md` in its own folder. Nothing for a folder whose name is longer than
 * Claude Code keeps whole (200 signs), which it shortens with a hash of its own.
 */
export function memoryPath(claudeHome: string, folder: string): string | undefined {
  const name = folder.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length > 200 ? undefined : join(claudeHome, "projects", name, "memory", "MEMORY.md");
}

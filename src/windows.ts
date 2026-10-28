/**
 * An agent's context window in Chips (Chips ADR 0146): how full one of this harness's agents is,
 * a person's Compact now, and the limit it compacts itself at. What the bridge works out; the
 * bridge itself hears the readings and runs the compactions.
 *
 * ACP says how full a session is with `usage_update`, `used` of `size` tokens, while a turn runs.
 * An agent has a session in each space it is in, and Chips one window for it: the copy is of the
 * session that said last, and Compact now compacts that one by saying `/compact` to it, which
 * Claude Code and Codex each take as a turn of its own. Until an agent has said, no copy is sent.
 * Its last reading, the limit a person picked, its last compaction and its last long turn are kept
 * with the bridge's agents, so a restart sends them again.
 *
 * Claude Code compacts itself near its auto-compact window, 33,000 tokens short of it (room for a
 * reply of 20,000, and 13,000 more). The person's settings set that window (`autoCompactWindow`,
 * or per model under `modelSettings`), or for this harness `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which
 * beats them and can't be changed from Chips. A limit picked in Chips goes in each of the agent's
 * sessions' own settings (`_meta.claudeCode.options.settings`), over the person's, never in a file.
 *
 * Codex says no limit over ACP, and compacts itself only near full. A limit picked in Chips is the
 * bridge's: after a turn that ends at or past it, the bridge compacts that session. So it is for
 * any other kind that offers `/compact`.
 */

import type { AgentContextWindowCopy } from "@chipschat/harness";
import { type LastCompaction, LONG_TURN_FOLDS_MAX, type LongTurn } from "@chipschat/protocol";
import { autoCompactOn, autoCompactWindowFromEnv, autoCompactWindowOf, type Layer } from "./claude-settings.js";

/** What the bridge keeps of an agent's window, by the agent's key. */
export interface KeptWindow {
  used: number;
  window: number;
  model?: string | undefined;
  asOf: string;
  /** The session that said last: the one Compact now compacts. */
  session: string;
  /** The limit a person picked in Chips, in percent; `null`, only when asked; absent, the harness's own. */
  limit?: number | null | undefined;
  last?: LastCompaction | undefined;
  longTurn?: LongTurn | undefined;
}

/** The limits a person may pick, in percent of the window. */
export const LIMITS: readonly number[] = [50, 60, 70, 80, 90];
/** How far short of its auto-compact window Claude Code compacts. */
export const HEADROOM = 33_000;
/** The least auto-compact window Claude Code takes. */
const LEAST_WINDOW = 100_000;

/** What Claude Code's own tool call for a compaction is called; Codex's has the same title. */
export const COMPACT_TITLE = "Compact conversation";
/** Codex's words, as a reply's, when it compacted itself the old way (`thread/compacted`). */
export const CODEX_COMPACTED = "*Context compacted to fit the model's context window.*";

type Limit = NonNullable<AgentContextWindowCopy["limit"]>;

/** The limit part of a copy: the limit, whether a person may change it, and why not. */
export interface LimitFacts {
  readonly limit?: Limit | undefined;
  readonly editable: boolean;
  readonly whyReadOnly?: string | undefined;
}

const ascending = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);

/** The percent of `window` at which Claude Code compacts, given its auto-compact window in tokens. */
export function percentOf(tokens: number, window: number): number {
  const at = Math.round(((Math.min(tokens, window) - HEADROOM) / window) * 100);
  return Math.min(99, Math.max(1, at));
}

/** The auto-compact window that makes Claude Code compact at `percent` of `window`. */
export function tokensFor(percent: number, window: number): number {
  return Math.min(window, Math.max(LEAST_WINDOW, Math.round((percent / 100) * window) + HEADROOM));
}

/** Whether Claude Code can be made to compact at `percent` of `window`, within what it takes. */
function reachable(percent: number, window: number): boolean {
  const tokens = Math.round((percent / 100) * window) + HEADROOM;
  return tokens >= LEAST_WINDOW && tokens <= window;
}

/**
 * Claude Code's own limit for an agent, in percent of its window: from
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`fixed`, as nothing here beats it), else from its settings,
 * else at the model's window; `null` where its settings turn compacting on its own off.
 */
export function claudeOwn(
  env: NodeJS.ProcessEnv,
  layers: readonly Layer[],
  model: string | undefined,
  window: number,
): { readonly at: number | null; readonly fixed: boolean } {
  const fromEnv = autoCompactWindowFromEnv(env);
  if (fromEnv !== undefined) return { at: percentOf(fromEnv, window), fixed: true };
  if (!autoCompactOn(layers)) return { at: null, fixed: false };
  return { at: percentOf(autoCompactWindowOf(layers, model) ?? window, window), fixed: false };
}

/** A Claude Code agent's limit: its own, marked, unless a person picked another. */
export function claudeLimit(kept: KeptWindow, own: { readonly at: number | null; readonly fixed: boolean }): LimitFacts {
  if (own.fixed) {
    return {
      limit: { at: own.at, choices: own.at === null ? [] : [own.at], default: own.at, may_turn_off: false },
      editable: false,
      whyReadOnly: "CLAUDE_CODE_AUTO_COMPACT_WINDOW sets it for this harness.",
    };
  }
  const at = kept.limit !== undefined ? kept.limit : own.at;
  const choices = ascending([
    ...LIMITS.filter((each) => reachable(each, kept.window)),
    ...(own.at === null ? [] : [own.at]),
    ...(typeof at === "number" ? [at] : []),
  ]);
  if (choices.length === 0) return { editable: false, whyReadOnly: "Its window is too small to pick a limit." };
  return { limit: { at, choices, default: own.at, may_turn_off: true }, editable: true };
}

/** A limit the bridge keeps (Codex, and any other kind that offers `/compact`): off unless picked. */
export function bridgeLimit(kept: KeptWindow): LimitFacts {
  const at = kept.limit ?? null;
  return {
    limit: { at, choices: ascending([...LIMITS, ...(typeof at === "number" ? [at] : [])]), default: null, may_turn_off: true },
    editable: true,
  };
}

/** Whether an agent is at or past the limit the bridge keeps for it. */
export function pastLimit(kept: KeptWindow): boolean {
  return typeof kept.limit === "number" && (kept.used / kept.window) * 100 >= kept.limit;
}

/**
 * The settings a Claude Code agent's sessions start with for the limit a person picked: its
 * auto-compact window, or compacting on its own off. None where nothing was picked.
 */
export function claudeSessionSettings(kept: KeptWindow | undefined): Record<string, unknown> | undefined {
  if (kept?.limit === undefined) return undefined;
  if (kept.limit === null) return { autoCompactEnabled: false };
  return { autoCompactEnabled: true, autoCompactWindow: tokensFor(kept.limit, kept.window) };
}

/** An agent's copy, as Chips takes it (`PUT /v1/agents/:id/context-window`). */
export function windowCopy(
  kept: KeptWindow,
  more: {
    readonly compacting?: "queued" | "running" | undefined;
    readonly compacts: boolean;
    readonly whyNot?: string | undefined;
  } & LimitFacts,
): AgentContextWindowCopy {
  return {
    used: Math.max(0, Math.round(kept.used)),
    window: Math.max(1, Math.round(kept.window)),
    ...(kept.model === undefined ? {} : { model: kept.model.slice(0, 120) }),
    as_of: kept.asOf,
    ...(more.compacting === undefined ? {} : { compacting: more.compacting }),
    ...(kept.last === undefined ? {} : { last: kept.last }),
    ...(kept.longTurn === undefined
      ? {}
      : { long_turn: { ...kept.longTurn, folds: Math.min(kept.longTurn.folds, LONG_TURN_FOLDS_MAX) } }),
    compacts: more.compacts,
    ...(more.compacts || more.whyNot === undefined ? {} : { why_not: more.whyNot }),
    ...(more.limit === undefined ? {} : { limit: more.limit }),
    editable: more.editable,
    ...(more.editable || more.whyReadOnly === undefined ? {} : { why_read_only: more.whyReadOnly }),
  };
}

/** Whether a tool call is the agent compacting: Claude Code's and Codex's are titled so. */
export function isCompaction(update: Readonly<Record<string, unknown>>): boolean {
  if (update["title"] === COMPACT_TITLE) return true;
  const meta = update["_meta"] as { claudeCode?: { toolName?: unknown } } | undefined;
  return meta?.claudeCode?.toolName === "compact";
}

/**
 * What a compaction's tool call says of it, where it says: Claude Code's `rawOutput` has
 * `{ trigger: "manual" | "automatic", preTokens, postTokens }`.
 */
export function compactionFacts(update: Readonly<Record<string, unknown>>): {
  from?: number;
  to?: number;
  by?: LastCompaction["by"];
} {
  const raw = update["rawOutput"] as Record<string, unknown> | undefined;
  if (typeof raw !== "object" || raw === null) return {};
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const from = number(raw["preTokens"]);
  const to = number(raw["postTokens"]);
  const trigger = raw["trigger"];
  const by = trigger === "manual" ? "asked" : trigger === "automatic" ? "itself" : undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(by === undefined ? {} : { by }),
  };
}

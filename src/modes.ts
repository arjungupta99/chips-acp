/**
 * The mode a person picks in Chips for this kind's sessions (Chips ADR 0300, addendum of 19
 * November 2026). The SDK hands the pick over as `chips.mode` while it holds, and says each change
 * with a `mode` event, its end included (SDK 1.0.11). Each session goes into the pick where the
 * kind offers it and its agent has it, else into the mode the kind starts in, and the bridge says
 * the mode it runs in through what it runs on its own (`modes`), so Chips can tell when the two
 * differ: Claude Code runs Auto as Accept edits on a model that can't use it.
 *
 * An SDK before 1.0.11 has no pick to hand over, so every session stays in the mode it starts in,
 * as before.
 */

import type { ConfigOption } from "./acp.js";
import type { KindMode } from "./kinds.js";

/** The pick, where the SDK hands one: its id, or nothing. */
export function pickedMode(chips: unknown): string | undefined {
  const mode = (chips as { readonly mode?: { readonly id?: unknown } | undefined } | undefined)?.mode;
  return typeof mode?.id === "string" && mode.id !== "" ? mode.id : undefined;
}

/**
 * Hear each change of the pick, where the SDK says them: true when it does. An older one has no
 * such event, and nothing is heard.
 */
export function onModeChange(chips: unknown, handler: () => void): boolean {
  const on = (chips as { readonly on?: (name: string, handler: () => void) => unknown }).on;
  if (typeof on !== "function" || !("mode" in (chips as object))) return false;
  on.call(chips, "mode", handler);
  return true;
}

/** A session's mode option, as both adapters name it: `category: "mode"`, or id `mode`. */
function modeOption(options: readonly ConfigOption[] | undefined): ConfigOption | undefined {
  return options?.find((option) => option.category === "mode") ?? options?.find((option) => option.id === "mode");
}

/** The modes a session's agent says it offers, in its order; nothing where it doesn't say. */
export function offeredIn(options: readonly ConfigOption[] | undefined): readonly string[] | undefined {
  const option = modeOption(options);
  return option === undefined || option.options.length === 0 ? undefined : option.options.map((each) => each.value);
}

/** The mode a session's agent says it runs in now; nothing where it doesn't say. */
export function currentIn(options: readonly ConfigOption[] | undefined): string | undefined {
  const value = modeOption(options)?.currentValue;
  return value === undefined || value === "" ? undefined : value;
}

/** What a session's permission option is at, where its agent has one: Copilot's Allow all (category `permissions`). */
export function permissionsIn(options: readonly ConfigOption[] | undefined): string | undefined {
  const value = options?.find((option) => option.category === "permissions")?.currentValue;
  return value === undefined || value === "" ? undefined : value;
}

/** A session's options with its mode as the agent now says it, for a `current_mode_update`. */
export function withCurrent(options: readonly ConfigOption[], mode: string): readonly ConfigOption[] {
  const option = modeOption(options);
  return option === undefined ? options : options.map((each) => (each === option ? { ...each, currentValue: mode } : each));
}

/**
 * The mode a session goes into: the pick where the kind offers it and the agent has it (where it
 * says), else the mode it starts in, and why, for the log.
 */
export function modeTarget(
  base: string,
  modes: readonly KindMode[],
  picked: string | undefined,
  offered: readonly string[] | undefined,
): { readonly mode: string; readonly why?: string } {
  if (picked === undefined || picked === base) return { mode: base };
  if (!modes.some((mode) => mode.id === picked)) {
    return { mode: base, why: `the mode picked in Chips, ${picked}, isn't one Chips may put it in` };
  }
  if (offered !== undefined && !offered.includes(picked)) {
    return { mode: base, why: `it doesn't offer ${picked} here, so it stays in ${base}` };
  }
  return { mode: picked };
}

/** The `modes` of what it runs on its own, as Chips's `own_rules.modes` has them. */
export interface OwnModes {
  readonly base: string;
  readonly running?: string | undefined;
  readonly offers: readonly KindMode[];
}

/**
 * The modes a person may pick: the kind's, less those its agent doesn't offer where it said, the
 * one it starts in always among them. Nothing for a kind with none.
 */
export function modesCopy(
  modes: readonly KindMode[],
  base: string,
  running: string | undefined,
  offered: readonly string[] | undefined,
): OwnModes | undefined {
  const offers = modes.filter((mode) => mode.id === base || offered === undefined || offered.includes(mode.id));
  if (offers.length === 0 || !offers.some((mode) => mode.id === base)) return undefined;
  return { base, ...(running === undefined ? {} : { running }), offers };
}

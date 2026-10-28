/**
 * An agent's model and effort in Chips (Chips ADRs 0140, 0241): what each of this harness's agents
 * runs on, of the choices its ACP adapter offers, and a person's pick. What the bridge works out;
 * the bridge itself asks the agent, and sets each pick on the agent's sessions.
 *
 * ACP offers a session's model and effort as its config options: one of category `model`, and,
 * while the session's model has levels, one of category `thought_level` with them (Claude Code's
 * `effort`, Codex's `reasoning_effort`). A session shows only its own model's levels, so the bridge
 * looks each time the agent starts: a session opened in the harness's folder, put on each model in
 * turn, and closed, with nothing said to it. A model the agent won't be put on is left out.
 *
 * What a new session starts on is the default: Claude Code's from its settings (or its own
 * `default`), Codex's from its config. An agent with no pick follows it. A pick is kept with the
 * agent, never in a file, and set on each of its sessions (`session/set_config_option`) as it opens
 * and when a person changes it. Dropped, the sessions go back on the default; Claude Code's
 * `default` effort hands the level back to its settings.
 *
 * Every model's label is the agent's, as is every level's but a few this bridge says more plainly.
 */

import type { AgentModelCopy } from "@chipschat/harness";
import { EFFORT_LEVELS_MAX, type EffortLevel, MODEL_CHOICES_MAX, type ModelChoice } from "@chipschat/protocol";
import type { ConfigOption } from "./acp.js";

/** A model and its level: an agent's pick, or what a new session starts on. */
export interface ModelPick {
  readonly model: string;
  readonly effort?: string | undefined;
}

/** What the agent offers to run on, as it last said when the bridge looked, kept with the bridge's agents. */
export interface Catalog {
  readonly choices: readonly ModelChoice[];
  readonly default: ModelPick;
  readonly asOf: string;
}

/** Claude Code's level that is no level: its settings', or the model's own. */
export const SETTINGS_LEVEL = "default";

/** Levels the agents name tersely, as a bar says them. */
const LEVEL_WORDS: Readonly<Record<string, string>> = { xhigh: "Extra high" };

/** The session's model option. */
export function modelOption(options: readonly ConfigOption[]): ConfigOption | undefined {
  return options.find((option) => option.category === "model");
}

/** The session's effort option: there while its model has levels. */
export function effortOption(options: readonly ConfigOption[]): ConfigOption | undefined {
  return options.find((option) => option.category === "thought_level");
}

/** Whether an option offers a value. */
export function offers(option: ConfigOption | undefined, value: string): boolean {
  return option?.options.some((each) => each.value === value) === true;
}

/** An effort option's levels, lowest first as the agent lists them: its highest eight, without Claude Code's `default`. */
function levelsOf(option: ConfigOption | undefined): EffortLevel[] {
  const levels = (option?.options ?? []).filter((each) => each.value !== SETTINGS_LEVEL);
  return levels.slice(-EFFORT_LEVELS_MAX).map((each) => ({
    id: each.value,
    label: (LEVEL_WORDS[each.value] ?? (each.name.trim() || each.value)).slice(0, 40),
  }));
}

/** The level an effort option is at, where it is at one. */
function levelOf(option: ConfigOption | undefined): string | undefined {
  const at = option?.currentValue;
  return at === undefined || at === "" || at === SETTINGS_LEVEL ? undefined : at;
}

/** What a session is on: the default, read from a new one. */
export function pickOf(options: readonly ConfigOption[]): ModelPick | undefined {
  const model = modelOption(options)?.currentValue;
  if (model === undefined || model === "") return undefined;
  const effort = levelOf(effortOption(options));
  return { model, ...(effort === undefined ? {} : { effort }) };
}

/**
 * What the agent offers, from a new session's options: each of its models, put on in turn (`set`)
 * for the levels it has. The one the session is on is the default. A model the agent refuses to be
 * put on is left out, with why. Nothing where the session offers no model.
 */
export async function lookAt(
  options: readonly ConfigOption[],
  set: (configId: string, value: string) => Promise<readonly ConfigOption[]>,
): Promise<{ readonly catalog?: Catalog; readonly refused: readonly { readonly model: string; readonly why: string }[] }> {
  const model = modelOption(options);
  const fallback = pickOf(options);
  if (model === undefined || fallback === undefined) return { refused: [] };
  const listed = model.options.some((each) => each.value === fallback.model)
    ? model.options
    : [{ value: fallback.model, name: fallback.model }, ...model.options];
  // Forty at most, the default always among them.
  let others = MODEL_CHOICES_MAX - 1;
  const offered = listed.filter((each) => each.value === fallback.model || others-- > 0);
  const choices: ModelChoice[] = [];
  const refused: { model: string; why: string }[] = [];
  for (const each of offered) {
    let levels = levelsOf(effortOption(options));
    if (each.value !== fallback.model) {
      try {
        const now = await set(model.id, each.value);
        if (modelOption(now)?.currentValue !== each.value) throw new Error("it stayed where it was");
        levels = levelsOf(effortOption(now));
      } catch (error) {
        refused.push({ model: each.value, why: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    choices.push({ id: each.value, label: (each.name.trim() || each.value).slice(0, 80), efforts: levels });
  }
  return { catalog: { choices, default: fallback, asOf: new Date().toISOString() }, refused };
}

/** The choice a model is, among those offered. */
function choiceOf(catalog: Catalog, model: string): ModelChoice | undefined {
  return catalog.choices.find((choice) => choice.id === model);
}

/** An agent's pick, where it is still one the agent offers; its level only where its model has it. */
export function pickIn(catalog: Catalog, pick: ModelPick | undefined): ModelPick | undefined {
  const choice = pick === undefined ? undefined : choiceOf(catalog, pick.model);
  if (pick === undefined || choice === undefined) return undefined;
  const effort = choice.efforts.some((level) => level.id === pick.effort) ? pick.effort : undefined;
  return { model: pick.model, ...(effort === undefined ? {} : { effort }) };
}

/**
 * A person's change as a pick: `null` for the default, nothing where it isn't one the agent offers.
 * A model with levels may come with none: it keeps the level the agent puts it at.
 */
export function pickFrom(
  catalog: Catalog,
  change: { readonly model: string | null; readonly effort: string | null },
): ModelPick | null | undefined {
  if (change.model === null) return null;
  const choice = choiceOf(catalog, change.model);
  if (choice === undefined) return undefined;
  if (change.effort === null) return { model: change.model };
  return choice.efforts.some((level) => level.id === change.effort) ? { model: change.model, effort: change.effort } : undefined;
}

/** An agent's copy, as Chips takes it (`PUT /v1/agents/:id/model`): its pick, else the default it follows. */
export function modelCopy(catalog: Catalog, pick: ModelPick | undefined, harness: string): AgentModelCopy {
  const own = pickIn(catalog, pick);
  const fallback = pickIn(catalog, catalog.default) ?? catalog.default;
  const runs = own ?? fallback;
  return {
    model: runs.model,
    ...(runs.effort === undefined ? {} : { effort: runs.effort }),
    own: own !== undefined,
    default: {
      label: `${harness}'s default`.slice(0, 80),
      model: fallback.model,
      ...(fallback.effort === undefined ? {} : { effort: fallback.effort }),
    },
    choices: [...catalog.choices],
    editable: true,
  };
}

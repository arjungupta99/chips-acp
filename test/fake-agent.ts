/**
 * An ACP agent in the test's own process, behind the same line-by-line wire a real one speaks
 * over stdio. What it does with a prompt is written in the prompt's last line:
 *
 * - anything else: a thought, a tool call that reads a file, two chunks of words, a usage update
 *   with its cost, and `end_turn`;
 * - `ask`: it asks permission to run `npm test`, and says which option it was given; `ask edit`,
 *   the same to edit `notes.md`; `ask shell`, the same as Claude Code asks for a command: titled by
 *   the command, with its own words for it in `description` (`ask shell <command>` for another);
 * - `form`: it asks with a form which colour, and says the answer;
 * - `slow`: it waits until cancelled;
 * - `cut`: it says half a sentence, then waits until cancelled;
 * - `nothing`: it says `NO_REPLY`;
 * - `refuse`: it stops with `refusal`;
 * - `die`: its process goes away mid-turn.
 * - `narrate`: it says what it will do, reads a file, and then answers.
 * - `pause`: it answers as anything else does, a moment later;
 * - `big`: it answers holding 150,000 tokens of its 200,000;
 * - `early`: it answers saying how full it is, with no result after (Claude Code's guess at its window);
 * - `fold`: it fills to 150,000, compacts itself to 30,000, and answers.
 *
 * With `compaction`, a prompt of `/compact` alone compacts the session to a quarter of what it held,
 * as Claude Code says it (`claude`: a tool call with `rawOutput`, then how full) or as Codex does
 * (`codex`: how full, then the tool call done); without, it says it doesn't know the command.
 * `model` is said with each reading, as Claude Code does; `commands` are the commands it offers.
 *
 * With `auth`, it says who it is signed in as after `initialize`: `out` is nobody, and it refuses
 * every turn, as Claude Code does signed out; with `refusesSessions` it refuses each session too, as
 * Codex does.
 *
 * With `opening`, each new session waits for it before it is made, as a slow agent's does.
 *
 * With `askFirst`, anything else said in the first session it was spoken to in asks permission to write the
 * tracker first, as a real agent asks before it changes something. It copies sessions (`session/fork`) unless `fork` is false, and
 * closes them (`session/close`) when `close` is true.
 *
 * With `models`, each session offers its model and its model's levels as config options, as Claude
 * Code's and Codex's adapters do (`FakeModels`), and is put on others with `session/set_config_option`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Wire } from "../src/acp.ts";

type Message = Record<string, unknown>;

/** What it offers to run on, and how it is put on another. */
export interface FakeModels {
  /** What a new session is on, and at what level. */
  readonly current: string;
  readonly effort?: string;
  /** What its model option lists, each with its levels, lowest first. */
  readonly choices: readonly { readonly id: string; readonly name: string; readonly efforts?: readonly string[] }[];
  /** Its effort option's id: Claude Code's `effort` unless said, Codex's `reasoning_effort`. */
  readonly effortId?: string;
  /** Claude Code's `default` level among its levels, which hands the level back to its settings. */
  readonly settingsLevel?: boolean;
  /** Models it lists and refuses to be put on. */
  readonly refuses?: readonly string[];
}

export interface FakeAgent {
  readonly wire: () => Wire;
  readonly prompts: string[];
  /** The session each prompt was said in. */
  readonly promptedIn: string[];
  readonly made: string[];
  readonly loaded: string[];
  readonly cancels: string[];
  /** What each `ask` was answered: the option picked, or `cancelled`. */
  readonly given: string[];
  /** `<session>:<mode>` for each mode it was put in. */
  readonly modes: string[];
  /** The folder each session was made, loaded or copied in, by session. */
  readonly cwds: Map<string, string>;
  /** `<session>><copy>` for each session it copied. */
  readonly forks: string[];
  readonly closed: string[];
  /** The `_meta` of each session made, loaded or copied, as `<method> <session>` and the meta. */
  readonly metas: { readonly call: string; readonly meta: unknown }[];
  /** `<session> <option>=<value>` for each option it was set to, refused or not. */
  readonly sets: string[];
  /** How many times it was started. */
  starts: number;
}

export function fakeAgent(
  options: {
    loadSession?: boolean;
    askFirst?: boolean;
    fork?: boolean;
    close?: boolean;
    auth?: "in" | "out";
    refusesSessions?: boolean;
    compaction?: "claude" | "codex";
    model?: string;
    commands?: readonly string[];
    models?: FakeModels;
    opening?: Promise<unknown>;
  } = {},
): FakeAgent {
  /** The first session it was spoken to in. */
  let spokenIn: string | undefined;
  const agent: FakeAgent = {
    metas: [],
    sets: [],
    prompts: [],
    promptedIn: [],
    made: [],
    loaded: [],
    cancels: [],
    given: [],
    modes: [],
    cwds: new Map(),
    forks: [],
    closed: [],
    starts: 0,
    wire: () => {
      agent.starts += 1;
      let listener: (line: string) => void = () => undefined;
      const closers: ((why: string) => void)[] = [];
      let gone = false;
      let asked = 0;
      const waiting = new Map<number, (result: Message) => void>();
      const cancelled = new Set<string>();
      const send = (message: Message) => {
        if (!gone) setImmediate(() => listener(JSON.stringify({ jsonrpc: "2.0", ...message })));
      };
      const update = (sessionId: string, body: Message) =>
        send({ method: "session/update", params: { sessionId, update: body } });
      /** What each session holds, as it last said. */
      const held = new Map<string, number>();
      /** What each session runs on, where it offers models. */
      const on = new Map<string, { model: string; effort?: string | undefined }>();
      const models = options.models;
      const effortId = models?.effortId ?? "effort";
      const choiceOf = (model: string) => models?.choices.find((choice) => choice.id === model);
      /** A session's options, as an answer carries them: none without `models`. */
      const configOptions = (sessionId: string): Message => {
        if (models === undefined) return {};
        const now = on.get(sessionId) ?? { model: models.current, effort: models.effort };
        on.set(sessionId, now);
        const listed = models.choices.map((choice) => ({ value: choice.id, name: choice.name }));
        // A model it doesn't list is offered first while a session is on it, as Codex does.
        if (choiceOf(now.model) === undefined) listed.unshift({ value: now.model, name: now.model });
        const levels = choiceOf(now.model)?.efforts ?? [];
        return {
          configOptions: [
            { id: "model", name: "Model", category: "model", type: "select", currentValue: now.model, options: listed },
            ...(levels.length === 0
              ? []
              : [
                  {
                    id: effortId,
                    name: "Effort",
                    category: "thought_level",
                    type: "select",
                    currentValue: now.effort ?? levels[0],
                    options: [
                      ...(models.settingsLevel === true ? [{ value: "default", name: "Default" }] : []),
                      ...levels.map((level) => ({ value: level, name: level.charAt(0).toUpperCase() + level.slice(1) })),
                    ],
                  },
                ]),
          ],
        };
      };
      /** Put on another model or level, or refused as the adapters refuse. */
      const setOption = (id: unknown, sessionId: string, configId: string, value: string) => {
        agent.sets.push(`${sessionId} ${configId}=${value}`);
        const now = on.get(sessionId);
        if (models === undefined || now === undefined) {
          send({ id, error: { code: -32602, message: "Invalid params" } });
          return;
        }
        if (configId === "model") {
          const choice = choiceOf(value);
          if (models.refuses?.includes(value) === true) {
            send({ id, error: { code: -32603, message: "Internal error" } });
            return;
          }
          if (choice === undefined && value !== now.model) {
            send({ id, error: { code: -32602, message: "Invalid params" } });
            return;
          }
          const levels = choice?.efforts ?? [];
          on.set(sessionId, { model: value, effort: levels.includes(now.effort ?? "") ? now.effort : levels[0] });
        } else if (configId === effortId) {
          const levels = choiceOf(now.model)?.efforts ?? [];
          if (value === "default" && models.settingsLevel === true) now.effort = models.effort;
          else if (levels.includes(value)) now.effort = value;
          else {
            send({ id, error: { code: -32602, message: "Invalid params" } });
            return;
          }
        }
        send({ id, result: configOptions(sessionId) });
      };
      const usage = (sessionId: string, used: number, cost?: number) => {
        held.set(sessionId, used);
        update(sessionId, {
          sessionUpdate: "usage_update",
          used,
          size: 200_000,
          ...(cost === undefined ? {} : { cost: { amount: cost, currency: "USD" } }),
          ...(options.model === undefined ? {} : { _meta: { "_claude/model": options.model } }),
        });
      };
      const compactCall = (sessionId: string, id: string, trigger: "manual" | "automatic", from: number, to: number) => {
        const meta = { claudeCode: { toolName: "compact" } };
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: "Compact conversation", kind: "think", status: "in_progress", _meta: meta });
        if (options.compaction === "codex") usage(sessionId, to);
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", _meta: meta });
        if (options.compaction === "codex") return;
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          rawOutput: { trigger, preTokens: from, postTokens: to },
          _meta: meta,
        });
        usage(sessionId, to);
      };
      const ask = (method: string, params: Message) =>
        new Promise<Message>((resolve) => {
          asked += 1;
          waiting.set(asked + 1000, resolve);
          send({ id: asked + 1000, method, params });
        });
      const die = (why: string) => {
        if (gone) return;
        gone = true;
        for (const closer of closers) closer(why);
      };

      const signedOut = { code: -32000, message: "Authentication required" };
      const prompt = async (id: unknown, sessionId: string, text: string) => {
        agent.prompts.push(text);
        agent.promptedIn.push(sessionId);
        if (options.auth === "out" || options.refusesSessions === true) {
          send({ id, error: signedOut });
          return;
        }
        const last = text.split("\n").at(-1)?.split(": ").at(-1)?.trim() ?? "";
        const reply = (stopReason: string) => send({ id, result: { stopReason } });
        const say = (words: string) =>
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
        if (text === "/compact") {
          if (options.compaction === undefined) say("Unknown command: /compact");
          else {
            const from = held.get(sessionId) ?? 1200;
            compactCall(sessionId, `compact-${agent.prompts.length}`, "manual", from, Math.round(from / 4));
            say("Compacted. ctrl+o to see the summary");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          reply("end_turn");
          return;
        }
        if (last === "early") {
          usage(sessionId, 5000);
          say("Early.");
          reply("end_turn");
          return;
        }
        if (last === "big") {
          say("Big answer.");
          usage(sessionId, 150_000, 0.5);
          await new Promise((resolve) => setTimeout(resolve, 10));
          reply("end_turn");
          return;
        }
        if (last === "fold") {
          usage(sessionId, 150_000);
          compactCall(sessionId, "compact-auto", "automatic", 150_000, 30_000);
          if (options.compaction === "codex") say("*Context compacted to fit the model's context window.*\n\n");
          say("Here is the answer.");
          usage(sessionId, 32_000, 0.4);
          await new Promise((resolve) => setTimeout(resolve, 10));
          reply("end_turn");
          return;
        }
        if (last === "pause") await new Promise((resolve) => setTimeout(resolve, 300));
        if (last === "cut") say("Half a sent");
        if (last === "slow" || last === "cut") {
          while (!cancelled.has(sessionId) && !gone) await new Promise((resolve) => setTimeout(resolve, 10));
          cancelled.delete(sessionId);
          reply("cancelled");
          return;
        }
        if (last === "die") {
          die("exited 1");
          return;
        }
        if (last === "refuse") {
          reply("refusal");
          return;
        }
        if (last === "narrate") {
          say("I'll read the notes first.");
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t3", title: "Read notes.md", kind: "read", status: "in_progress" });
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t3", status: "completed" });
          say("Here is the answer.");
          await new Promise((resolve) => setTimeout(resolve, 20));
          reply("end_turn");
          return;
        }
        if (last === "send") {
          // A page written in its folder and named as the Chips SDK says, and a file outside it.
          writeFileSync(join(agent.cwds.get(sessionId) ?? ".", "page.html"), "<p>play</p>");
          say("The page is ready.\n\nMEDIA:page.html\nMEDIA:/etc/hosts");
          reply("end_turn");
          return;
        }
        if (last === "nothing") {
          say("NO_REPLY");
          reply("end_turn");
          return;
        }
        if (last === "ask") {
          const answer = await ask("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "t2", title: "Run npm test", kind: "execute", rawInput: { command: "npm test" } },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          const outcome = answer["outcome"] as { outcome: string; optionId?: string };
          agent.given.push(outcome.optionId ?? outcome.outcome);
          say(outcome.outcome === "selected" ? `Given: ${outcome.optionId}` : "Given nothing");
          reply("end_turn");
          return;
        }
        if (last.startsWith("ask shell")) {
          const command = last.slice("ask shell".length).trim() || "grep -noE 'card-(front|back)' game.js | sort | uniq -c";
          const answer = await ask("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "t4",
              title: command,
              kind: "execute",
              rawInput: { command, description: "Count class names in game.js" },
            },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          const outcome = answer["outcome"] as { outcome: string; optionId?: string };
          say(outcome.outcome === "selected" ? `Given: ${outcome.optionId}` : "Given nothing");
          reply("end_turn");
          return;
        }
        if (last === "ask edit") {
          const answer = await ask("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "t3", title: "Edit notes.md", kind: "edit", rawInput: { path: "notes.md" } },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          const outcome = answer["outcome"] as { outcome: string; optionId?: string };
          say(outcome.outcome === "selected" ? `Given: ${outcome.optionId}` : "Given nothing");
          reply("end_turn");
          return;
        }
        if (last === "form") {
          const answer = await ask("elicitation/create", {
            sessionId,
            message: "Pick one",
            requestedSchema: {
              type: "object",
              properties: { colour: { type: "string", title: "Which colour?", enum: ["red", "blue"] } },
            },
          });
          const content = answer["content"] as { colour?: string } | undefined;
          say(`${String(answer["action"])}: ${content?.colour ?? "none"}`);
          reply("end_turn");
          return;
        }
        spokenIn ??= sessionId;
        if (options.askFirst === true && sessionId === spokenIn) {
          await ask("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "t0", title: "Edit tracker.md", kind: "edit", rawInput: { path: "tracker.md" } },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t0", title: "Edit tracker.md", kind: "edit" });
          update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t0", status: "completed" });
        }
        update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me look at the notes." },
        });
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read notes.md",
          kind: "read",
          status: "in_progress",
        });
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
        say("Here is ");
        say("the answer.");
        usage(sessionId, last === "pause" ? 1300 : 1200, 0.02);
        await new Promise((resolve) => setTimeout(resolve, 20));
        reply("end_turn");
      };

      /** A line from the bridge; `opened`, a new session's again once `opening` let it through. */
      const hear = (line: string, opened = false) => {
        const message = JSON.parse(line) as Message;
        const params = (message["params"] ?? {}) as Message;
        const id = message["id"];
        if (message["method"] === undefined && typeof id === "number") {
          waiting.get(id)?.((message["result"] ?? {}) as Message);
          waiting.delete(id);
          return;
        }
        switch (message["method"]) {
          case "initialize":
            send({
              id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  ...(options.auth === undefined ? {} : { _meta: { authStatus: {} } }),
                  loadSession: options.loadSession === true,
                  sessionCapabilities: {
                    ...(options.fork === false ? {} : { fork: {} }),
                    ...(options.close === true ? { close: {} } : {}),
                  },
                },
                agentInfo: { name: "fake-agent" },
                authMethods: [{ id: "fake-login", name: "Fake sign-in" }],
              },
            });
            if (options.auth !== undefined) {
              const authStatus = options.auth === "in" ? { kind: "account", label: "Test account" } : { kind: "none", label: "Not logged in" };
              setTimeout(() => send({ method: "_auth/status_update", params: { authStatus } }), 30);
            }
            return;
          case "session/new": {
            if (options.refusesSessions === true) {
              send({ id, error: signedOut });
              return;
            }
            if (options.opening !== undefined && !opened) {
              void options.opening.then(() => hear(line, true));
              return;
            }
            const sessionId = `sess-${agent.made.length + agent.loaded.length + 1}-${agent.starts}`;
            agent.made.push(sessionId);
            agent.cwds.set(sessionId, String(params["cwd"]));
            agent.metas.push({ call: `new ${sessionId}`, meta: params["_meta"] });
            send({ id, result: { sessionId, ...configOptions(sessionId) } });
            if (options.commands !== undefined) {
              update(sessionId, {
                sessionUpdate: "available_commands_update",
                availableCommands: options.commands.map((name) => ({ name, description: name, input: null })),
              });
            }
            return;
          }
          case "session/load":
            agent.loaded.push(String(params["sessionId"]));
            agent.cwds.set(String(params["sessionId"]), String(params["cwd"]));
            agent.metas.push({ call: `load ${String(params["sessionId"])}`, meta: params["_meta"] });
            send({ id, result: models === undefined ? null : configOptions(String(params["sessionId"])) });
            return;
          case "session/fork": {
            if (options.fork === false) break;
            const sessionId = `fork-${agent.forks.length + 1}`;
            agent.forks.push(`${String(params["sessionId"])}>${sessionId}`);
            agent.cwds.set(sessionId, String(params["cwd"]));
            const original = on.get(String(params["sessionId"]));
            if (original !== undefined) on.set(sessionId, { ...original });
            send({ id, result: { sessionId, ...configOptions(sessionId) } });
            return;
          }
          case "session/close":
            if (options.close !== true) break;
            agent.closed.push(String(params["sessionId"]));
            // Loaded again, it runs on what a new one does.
            on.delete(String(params["sessionId"]));
            send({ id, result: {} });
            return;
          case "session/prompt": {
            const blocks = (params["prompt"] ?? []) as { text?: string }[];
            void prompt(id, String(params["sessionId"]), blocks.map((block) => block.text ?? "").join("\n"));
            return;
          }
          case "session/set_config_option":
            setOption(id, String(params["sessionId"]), String(params["configId"]), String(params["value"]));
            return;
          case "session/set_mode":
            agent.modes.push(`${String(params["sessionId"])}:${String(params["modeId"])}`);
            send({ id, result: {} });
            return;
          case "session/cancel":
            agent.cancels.push(String(params["sessionId"]));
            cancelled.add(String(params["sessionId"]));
            return;
          default:
            break;
        }
        if (id !== undefined) send({ id, error: { code: -32601, message: "no such method" } });
      };

      return {
        write: (line) => {
          if (!gone) setImmediate(() => hear(line));
        },
        onLine: (handler) => {
          listener = handler;
        },
        onClose: (handler) => closers.push(handler),
        close: () => die("closed"),
      };
    },
  };
  return agent;
}

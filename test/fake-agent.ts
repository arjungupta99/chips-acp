/**
 * An ACP agent in the test's own process, behind the same line-by-line wire a real one speaks
 * over stdio. What it does with a prompt is written in the prompt's last line:
 *
 * - anything else: a thought, a tool call that reads a file, two chunks of words, a usage update
 *   with its cost, and `end_turn`;
 * - `ask`: it asks permission to run `npm test`, and says which option it was given;
 * - `form`: it asks with a form which colour, and says the answer;
 * - `slow`: it waits until cancelled;
 * - `nothing`: it says `NO_REPLY`;
 * - `refuse`: it stops with `refusal`;
 * - `die`: its process goes away mid-turn.
 * - `narrate`: it says what it will do, reads a file, and then answers.
 *
 * With `askFirst`, anything else said in the first session it made asks permission to write the
 * tracker first, as a real agent asks before it changes something. It copies sessions (`session/fork`) unless `fork` is false, and
 * closes them (`session/close`) when `close` is true.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Wire } from "../src/acp.ts";

type Message = Record<string, unknown>;

export interface FakeAgent {
  readonly wire: () => Wire;
  readonly prompts: string[];
  readonly made: string[];
  readonly loaded: string[];
  readonly cancels: string[];
  /** `<session>:<mode>` for each mode it was put in. */
  readonly modes: string[];
  /** The folder each session was made, loaded or copied in, by session. */
  readonly cwds: Map<string, string>;
  /** `<session>><copy>` for each session it copied. */
  readonly forks: string[];
  readonly closed: string[];
  /** How many times it was started. */
  starts: number;
}

export function fakeAgent(
  options: { loadSession?: boolean; askFirst?: boolean; fork?: boolean; close?: boolean } = {},
): FakeAgent {
  const agent: FakeAgent = {
    prompts: [],
    made: [],
    loaded: [],
    cancels: [],
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

      const prompt = async (id: unknown, sessionId: string, text: string) => {
        agent.prompts.push(text);
        const last = text.split("\n").at(-1)?.split(": ").at(-1)?.trim() ?? "";
        const reply = (stopReason: string) => send({ id, result: { stopReason } });
        const say = (words: string) =>
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: words } });
        if (last === "slow") {
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
        if (options.askFirst === true && sessionId === agent.made[0]) {
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
        update(sessionId, {
          sessionUpdate: "usage_update",
          used: 1200,
          size: 200_000,
          cost: { amount: 0.02, currency: "USD" },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        reply("end_turn");
      };

      const hear = (line: string) => {
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
                  loadSession: options.loadSession === true,
                  sessionCapabilities: {
                    ...(options.fork === false ? {} : { fork: {} }),
                    ...(options.close === true ? { close: {} } : {}),
                  },
                },
                agentInfo: { name: "fake-agent" },
              },
            });
            return;
          case "session/new": {
            const sessionId = `sess-${agent.made.length + agent.loaded.length + 1}-${agent.starts}`;
            agent.made.push(sessionId);
            agent.cwds.set(sessionId, String(params["cwd"]));
            send({ id, result: { sessionId } });
            return;
          }
          case "session/load":
            agent.loaded.push(String(params["sessionId"]));
            agent.cwds.set(String(params["sessionId"]), String(params["cwd"]));
            send({ id, result: null });
            return;
          case "session/fork": {
            if (options.fork === false) break;
            const sessionId = `fork-${agent.forks.length + 1}`;
            agent.forks.push(`${String(params["sessionId"])}>${sessionId}`);
            agent.cwds.set(sessionId, String(params["cwd"]));
            send({ id, result: { sessionId } });
            return;
          }
          case "session/close":
            if (options.close !== true) break;
            agent.closed.push(String(params["sessionId"]));
            send({ id, result: {} });
            return;
          case "session/prompt": {
            const blocks = (params["prompt"] ?? []) as { text?: string }[];
            void prompt(id, String(params["sessionId"]), blocks.map((block) => block.text ?? "").join("\n"));
            return;
          }
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

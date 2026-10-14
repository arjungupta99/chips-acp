/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and an ACP agent in this process.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chips/conformance";
import { type Chips, connect } from "@chips/harness";
import { Bridge, type BridgeState, keyOf } from "../src/bridge.ts";
import { type FakeAgent, fakeAgent } from "./fake-agent.ts";

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly agent: FakeAgent;
  readonly state: BridgeState;
  readonly agentId: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(
  options: { agent?: FakeAgent; state?: BridgeState; chips?: FakeChips } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents", "restarts"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const agent = options.agent ?? fakeAgent();
  const state = options.state ?? { sessions: {} };
  const bridge = new Bridge({
    chips: client,
    agents: [{ name: "Fakey", command: ["fake"], cwd: mkdtempSync(join(tmpdir(), "chips-acp-")) }],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    wireFor: () => agent.wire(),
    respawnMs: 20,
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  const agents = await client.agents.list();
  const agentId = agents.find((each) => each.key === keyOf({ name: "Fakey" }))?.agentId ?? "";
  return { chips, client, bridge, agent, state, agentId };
}

/** Once `done` holds, checked every few milliseconds: for what the log doesn't show. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const by = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The first event of a type the bridge's agent sent, with more to match when given. */
function sent(
  chips: FakeChips,
  type: string,
  more: (event: StoredEvent) => boolean = () => true,
): Promise<StoredEvent> {
  return chips.waitFor(
    (event) => (event.type === type && more(event) ? event : undefined),
    3000,
  );
}

describe("a turn", () => {
  it("is a run: a status, a step, the words in the room, its cost, and the end", async () => {
    const { chips, agentId } = await rig();
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    assert.equal(started.actor.id, agentId, "the Main agent took it");
    assert.equal(started.payload["goal"], "summarise the notes");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(step.payload["tool"], "read");
    assert.equal(step.payload["title"], "read · Read notes.md");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
    const usage = await sent(chips, "usage");
    assert.deepEqual(usage.payload["cost"], { usd: 0.02, estimated: true });
    const done = await sent(chips, "run.completed");
    assert.equal(done.payload["summary"], "Here is the answer.");
  });

  it("hands the agent the room's note and who said it", async () => {
    const { chips, agent } = await rig();
    await chips.say("hello there");
    await sent(chips, "run.completed");
    const prompt = agent.prompts[0] ?? "";
    assert.match(prompt, /In this room:/);
    assert.match(prompt, /: hello there$/);
  });

  it("keeps one session per room, and a second message is the same session", async () => {
    const { chips, agent, state } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1);
    assert.deepEqual(Object.values(state.sessions), agent.made);
  });

  it("passes when the agent says NO_REPLY, and fails when it refuses", async () => {
    const { chips } = await rig();
    await chips.say("nothing");
    await sent(chips, "turn.passed");
    await sent(chips, "run.completed");
    await chips.say("refuse");
    const failed = await sent(chips, "run.failed");
    assert.match(String(failed.payload["error"]), /refused/);
  });
});

describe("what it asks", () => {
  it("asks permission on a card, and gives the agent its always when a person allows always", async () => {
    const { chips } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    assert.equal((asked.payload["action"] as { kind: string }).kind, "acp.execute");
    assert.equal(asked.payload["question"], "Allow it to run npm test?");
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: always");
  });

  it("gives it its reject when a person says no", async () => {
    const { chips } = await rig();
    await chips.say("ask");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "denied");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: no");
  });

  it("asks a form's choice as a question card, and hands back the answer", async () => {
    const { chips } = await rig();
    await chips.say("form");
    const asked = await sent(chips, "question.ask");
    await chips.answer(String(asked.payload["ask_id"]), { colour: ["blue"] });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "accept: blue");
  });
});

describe("what a person does to it", () => {
  it("stops the agent's turn when a person stops the run", async () => {
    const { chips, agent } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => agent.prompts.length > 0);
    await chips.asOwner({ type: "run.cancel", space_id: started.space_id, run_id: started.run_id });
    await until(() => agent.cancels.length > 0);
    assert.deepEqual(agent.cancels, agent.made, "the room's session, stopped");
  });
});

describe("an agent that stops", () => {
  it("fails the turn it was in, says it can't answer, and runs again", async () => {
    const { chips, agent } = await rig();
    await chips.say("die");
    const failed = await sent(chips, "run.failed");
    assert.match(String(failed.payload["error"]), /Fakey stopped/);
    await until(() => agent.starts >= 2);
    await chips.say("back again");
    const words = await sent(chips, "message.post", (event) => event.payload["text"] === "Here is the answer.");
    assert.ok(words);
  });

  it("runs afresh on a person's Restart, and answers after", async () => {
    const { chips, agent, bridge } = await rig();
    await bridge.restart();
    assert.equal(agent.starts, 2);
    await chips.say("after the restart");
    const words = await sent(chips, "message.post", (event) => event.payload["text"] === "Here is the answer.");
    assert.ok(words);
  });

  it("loads a room's session after a restart, where the agent can", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "restarts"] });
    open.push(() => chips.close());
    const agent = fakeAgent({ loadSession: true });
    const state: BridgeState = { sessions: {} };
    const first = await rig({ chips, agent, state });
    await chips.say("one");
    await sent(chips, "run.completed");
    first.bridge.stop();
    first.client.close();

    const again = await rig({ chips, agent, state });
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1, "no second session");
    assert.deepEqual(agent.loaded, agent.made, "the first one, loaded");
    again.bridge.stop();
  });
});

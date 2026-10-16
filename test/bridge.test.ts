/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and an ACP agent in this process.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge, type BridgeState, forkName, goalOf, type KindConfig, titleFrom } from "../src/bridge.ts";
import { type FakeAgent, fakeAgent } from "./fake-agent.ts";

const CAPABILITIES = ["agents", "new_spaces", "new_agents", "forks", "restarts"];

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly agent: FakeAgent;
  readonly state: BridgeState;
  readonly kind: KindConfig;
  /** The agent Chips gave the harness, in its own room. */
  readonly agentId: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(
  options: {
    agent?: FakeAgent;
    state?: BridgeState;
    chips?: FakeChips;
    mode?: string;
    idleMs?: number;
    folders?: string;
    folder?: string;
  } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" }));
  if (options.chips === undefined) open.push(() => chips.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const agent = options.agent ?? fakeAgent();
  const state = options.state ?? { sessions: {}, agents: {} };
  const kind: KindConfig = {
    name: "Fakey",
    command: ["fake"],
    folders: options.folders ?? mkdtempSync(join(tmpdir(), "chips-acp-")),
    ...(options.folder === undefined ? {} : { folder: options.folder }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const bridge = new Bridge({
    chips: client,
    kind,
    state,
    saveState: () => undefined,
    wire: () => agent.wire(),
    respawnMs: 20,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  const agents = await client.agents.list();
  const agentId = agents.find((each) => each.key === chips.address.harnessId)?.agentId ?? "";
  return { chips, client, bridge, agent, state, kind, agentId };
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

/** The record of an agent the bridge keeps, by its name. */
function recordNamed(state: BridgeState, name: string) {
  return Object.values(state.agents).find((record) => record.name === name);
}

/**
 * The record that has an agent's id: Chips says the agent joined before `register` answers the
 * bridge, so the record takes its id a moment after.
 */
async function recordOf(state: BridgeState, joined: StoredEvent) {
  const agentId = String(joined.payload["participant_id"]);
  await until(() => Object.values(state.agents).some((record) => record.agentId === agentId));
  return Object.values(state.agents).find((record) => record.agentId === agentId);
}

/** A new agent asked for by name in a room of its own, once it has joined: the room. */
async function newAgent(chips: FakeChips, state: BridgeState, name: string): Promise<string> {
  const spaceId = await chips.openRoom(`${name}'s room`);
  const { askId } = await chips.askForAgent(spaceId, name);
  await recordOf(state, await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId));
  return spaceId;
}

describe("a turn", () => {
  it("names its run by the words after the agent's whole @name", () => {
    const message = (text: string) => ({ text, from: { display_name: "Arjun" } }) as Parameters<typeof goalOf>[0];
    assert.equal(goalOf(message("@Claude Code Delete second.txt"), "Claude Code"), "Delete second.txt");
    assert.equal(goalOf(message("@Codex Run curl"), "Codex"), "Run curl");
    assert.equal(goalOf(message("@Claude Code"), "Claude Code"), "Answer Arjun");
  });

  it("answers with its last words: what it said before a tool call is the bubble's", async () => {
    const { chips } = await rig();
    await chips.say("narrate");
    const started = await sent(chips, "run.started");
    const status = await sent(chips, "run.status", (event) => event.payload["phase"] === "writing");
    assert.equal(status.payload["verb_phrase"], "I'll read the notes first.");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
  });

  it("puts each session in the mode the config names, and names the kind on the gauge", async () => {
    const { chips, agent } = await rig({ mode: "default" });
    await chips.say("hello");
    const gauge = await sent(chips, "context.usage");
    assert.equal(gauge.payload["model"], "Fakey");
    await sent(chips, "run.completed");
    assert.deepEqual(agent.modes, [`${agent.made[0]}:default`]);
  });

  it("is a run: a status, a step, the words in the room, its cost, and the end", async () => {
    const { chips, agentId } = await rig();
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    assert.equal(started.actor.id, agentId, "the harness's own agent took it");
    assert.equal(started.payload["goal"], "summarise the notes");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(step.payload["tool"], "read");
    assert.equal(step.payload["kind"], "file", "ACP's read is a file, drawn as one");
    assert.equal(step.payload["title"], "read · Read notes.md");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
    const usage = await sent(chips, "usage");
    assert.deepEqual(usage.payload["cost"], { usd: 0.02, estimated: true });
    assert.equal(usage.payload["output_tokens"], undefined, "the cost alone, no made-up tokens");
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

describe("no Main agent", () => {
  it("registers none: the harness's own agent is an ordinary one, in a folder of its own", async () => {
    const { chips, agent, state, kind, agentId } = await rig();
    const agents = [...chips.workspace.agents.values()];
    assert.ok(agents.length > 0 && agents.every((each) => !each.lead), "nothing is the Main agent");
    const own = recordNamed(state, "Fakey");
    assert.equal(own?.agentId, agentId);
    assert.equal(own?.folder, join(kind.folders, "fakey"));
    assert.ok(existsSync(own?.folder ?? ""), "its folder is made");
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.equal(agent.cwds.get(agent.made[0] ?? ""), own?.folder, "its session works in its folder");
  });

  it("lets a person move the harness's own agent out of its room", async () => {
    const { chips, agentId } = await rig();
    const elsewhere = await chips.openRoom("Elsewhere");
    const moved = chips.workspace.moveAgent(agentId, elsewhere);
    assert.ok(moved.ok, JSON.stringify(moved));
    await chips.say("over here", elsewhere);
    const started = await sent(chips, "run.started", (event) => event.space_id === elsewhere);
    assert.equal(started.actor.id, agentId);
  });

  it("works every agent in the one folder the config names, where it names one", async () => {
    const folder = mkdtempSync(join(tmpdir(), "chips-acp-shared-"));
    const { chips, agent, state } = await rig({ folder });
    assert.equal(recordNamed(state, "Fakey")?.folder, folder);
    await newAgent(chips, state, "Nova");
    assert.equal(recordNamed(state, "Nova")?.folder, folder);
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.equal(agent.cwds.get(agent.made[0] ?? ""), folder);
  });
});

describe("a session that goes quiet", () => {
  it("is closed, and loaded again on the next message", async () => {
    const agent = fakeAgent({ loadSession: true, close: true });
    const { chips, state } = await rig({ agent, idleMs: 60 });
    await chips.say("one");
    await sent(chips, "run.completed");
    await until(() => agent.closed.length === 1);
    assert.deepEqual(agent.closed, agent.made, "the room's session, closed");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1, "no second session");
    assert.deepEqual(agent.loaded, agent.made, "the first one, loaded");
    assert.deepEqual(Object.values(state.sessions), agent.made);
  });

  it("stays open where the agent couldn't load it again", async () => {
    const agent = fakeAgent({ close: true });
    const { chips } = await rig({ agent, idleMs: 30 });
    await chips.say("one");
    await sent(chips, "run.completed");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(agent.closed, []);
  });
});

describe("a new agent a person asks for", () => {
  it("is made in a folder of its own, joins the room, and answers there", async () => {
    const { chips, agent, state, kind } = await rig();
    const spaceId = await chips.openRoom("Fresh eyes");
    const { askId } = await chips.askForAgent(spaceId, "Nova");
    const joined = await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const nova = await recordOf(state, joined);
    assert.equal(nova?.name, "Nova");
    assert.equal(nova?.folder, join(kind.folders, "nova"));
    assert.ok(existsSync(nova?.folder ?? ""));
    await chips.say("@Nova hello", spaceId);
    const started = await sent(chips, "run.started", (event) => event.space_id === spaceId);
    assert.equal(started.actor.id, nova?.agentId);
    assert.equal(started.payload["goal"], "hello");
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    assert.equal(agent.cwds.get(state.sessions[`${nova?.key}|${spaceId}`] ?? ""), nova?.folder);
  });

  it("is forgotten when a person deletes it, and its folder stays", async () => {
    const { chips, state } = await rig();
    const spaceId = await newAgent(chips, state, "Nova");
    await chips.say("@Nova hello", spaceId);
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    assert.ok(chips.workspace.deleteAgent(nova.agentId));
    await until(() => state.agents[nova.key] === undefined);
    assert.equal(state.sessions[`${nova.key}|${spaceId}`], undefined, "its sessions forgotten");
    assert.ok(existsSync(nova.folder), "what it wrote is kept");
  });

  it("takes a folder no other agent has, nor one a deleted agent left", async () => {
    const { chips, state, kind } = await rig();
    await newAgent(chips, state, "Nova");
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    chips.workspace.deleteAgent(nova.agentId);
    await until(() => recordNamed(state, "Nova") === undefined);
    await newAgent(chips, state, "Nova");
    // Chips numbers the name (the deleted one keeps "Nova" in what it said); the folder is new too.
    const again = Object.values(state.agents).find((record) => record.name.startsWith("Nova"));
    assert.equal(again?.folder, join(kind.folders, "nova-2"));
  });

  it("takes the name a person gives it", async () => {
    const { chips, state } = await rig();
    await newAgent(chips, state, "Nova");
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    assert.ok(chips.workspace.renameAgent(nova.agentId, "Vega").ok);
    await until(() => nova.name === "Vega");
  });
});

describe("a room from the +", () => {
  it("is claimed and named, and a new agent in a folder of its own answers the first words", async () => {
    const { chips, agent, state, kind } = await rig();
    const { spaceId } = await chips.askForSpace("Plan a weekend in Lisbon for two");
    const claimed = await sent(chips, "space.claimed", (event) => event.space_id === spaceId);
    assert.equal(claimed.payload["title"], "Plan a weekend in Lisbon for two");
    const words = await sent(chips, "message.post", (event) => event.space_id === spaceId && event.run_id !== null);
    const milo = recordNamed(state, "Milo");
    assert.ok(milo !== undefined, "the agent Chips made for the claim, by the name the room held");
    assert.equal(words.actor.id, milo.agentId);
    assert.equal(milo.folder, join(kind.folders, "milo"));
    const session = state.sessions[`${milo.key}|${spaceId}`] ?? "";
    assert.equal(agent.cwds.get(session), milo.folder);
    assert.match(agent.prompts.at(-1) ?? "", /: Plan a weekend in Lisbon for two$/);
    const started = await sent(chips, "run.started", (event) => event.space_id === spaceId);
    assert.equal(started.payload["goal"], "Plan a weekend in Lisbon for two");
  });

  it("names a room from the first line of what it is for", () => {
    assert.equal(titleFrom("Short one\nand more"), "Short one");
    assert.equal(
      titleFrom("Work out why the nightly backup to the NAS keeps failing after midnight"),
      "Work out why the nightly backup to the NAS…",
    );
  });
});

describe("a copy a person asks for", () => {
  it("copies the agent's session in the room it is in, and works on in the same folder", async () => {
    const { chips, agent, state, agentId } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    const original = recordNamed(state, "Fakey");
    assert.ok(original !== undefined);
    const spaceId = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, spaceId);
    const joined = await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    const copy = await recordOf(state, joined);
    assert.ok(copy !== undefined);
    assert.equal(copy.name, "Fakey · fork");
    assert.equal(copy.forkedFrom, agentId);
    assert.equal(copy.folder, original.folder, "the same files as the conversation it remembers");
    assert.deepEqual(agent.forks, [`${agent.made[0]}>fork-1`]);
    assert.equal(agent.cwds.get("fork-1"), original.folder);
    assert.equal(state.sessions[`${copy.key}|${spaceId}`], "fork-1");
    await chips.say("@Fakey · fork two", spaceId);
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    assert.equal(agent.made.length, 1, "the copy speaks in its copied session, not a new one");
  });

  it("copies an agent that never spoke as a new one in the same folder", async () => {
    const { chips, agent, state, agentId } = await rig();
    const spaceId = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, spaceId);
    await recordOf(state, await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId));
    assert.deepEqual(agent.forks, []);
    assert.equal(recordNamed(state, "Fakey · fork")?.folder, recordNamed(state, "Fakey")?.folder);
  });

  it("makes no copy where the agent can't copy a session", async () => {
    const agent = fakeAgent({ fork: false });
    const { chips, state, agentId } = await rig({ agent });
    await chips.say("one");
    await sent(chips, "run.completed");
    const spaceId = await chips.openRoom("Second opinion");
    await chips.askForFork(agentId, spaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(recordNamed(state, "Fakey · fork"), undefined);
  });

  it("is called after its original, as Jacobian calls a fork", () => {
    assert.equal(forkName("Nova"), "Nova · fork");
    assert.equal(forkName("Nova · fork 2"), "Nova · fork");
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

  it("keeps its agents and loads a room's session after a restart, where the agent can", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" });
    open.push(() => chips.close());
    const agent = fakeAgent({ loadSession: true });
    const state: BridgeState = { sessions: {}, agents: {} };
    const folders = mkdtempSync(join(tmpdir(), "chips-acp-"));
    const first = await rig({ chips, agent, state, folders });
    await chips.say("one");
    await sent(chips, "run.completed");
    const before = structuredClone(state.agents);
    first.bridge.stop();
    first.client.close();

    const again = await rig({ chips, agent, state, folders });
    assert.deepEqual(state.agents, before, "the same agents, in the same folders");
    await chips.say("two");
    await chips.waitFor(
      (event) => (event.type === "run.completed" && agent.prompts.length === 2 ? event : undefined),
      3000,
    );
    assert.equal(agent.made.length, 1, "no second session");
    assert.deepEqual(agent.loaded, agent.made, "the first one, loaded");
    again.bridge.stop();
  });

  it("forgets an agent deleted while it was away", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES, harnessName: "Fakey" });
    open.push(() => chips.close());
    const state: BridgeState = { sessions: {}, agents: {} };
    const first = await rig({ chips, state });
    await newAgent(chips, state, "Nova");
    first.bridge.stop();
    first.client.close();
    const nova = recordNamed(state, "Nova");
    assert.ok(nova !== undefined);
    chips.workspace.deleteAgent(nova.agentId);

    await rig({ chips, state });
    assert.equal(recordNamed(state, "Nova"), undefined);
    assert.ok(recordNamed(state, "Fakey") !== undefined);
  });
});

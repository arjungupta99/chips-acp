/**
 * The gallery's ACP card, run as a person runs it, against a scratch Chips and the fake agent
 * (Chips ADRs 0122, 0171; its findings' ON-8): what isn't set up stops it before the link is
 * spent; then it joins with what the card grants and says hello once; started again it says
 * nothing more; and a new link is taken up in place of the key it kept.
 *
 * Claude Code's card needs no config, so the first runs are on a PATH of the test's own, which
 * this machine's real `claude` and `claude-agent-acp` aren't on: with no Claude Code, then with a
 * `claude` that stands in for it and no adapter (the bridge fetches none for Claude Code, Chips
 * ADR 0288). Then a config names a command of the test's own, the fake agent, signed out and then
 * in.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { STILL_GOOD } from "../../src/setup.ts";
import { type CardLink, here, type ScratchChips, scratchChips, skip } from "./kit.ts";

const AGENT = "chips-acp-e2e-agent";
const HELLO = /^Hi, I'm Claude Code\. Ask me anything here, or make me an agent from any space\.$/;
const CONNECTED = /connected as hrn_\w+ \(Claude Code\), \d+ agent\(s\)/;

describe("ACP's card, from a link to its hello", { skip, timeout: 180_000 }, () => {
  let chips: ScratchChips;
  let home: string;
  let card: CardLink;
  /** The PATH with the agent's command installed on it. */
  let installed: string;
  /** A folder holding a `claude` and nothing else: Claude Code installed, as far as a PATH says. */
  let claudeOnly: string;
  /** The config naming the fake agent as Claude Code's command, with what it is run with. */
  const config = (env: Record<string, string>) => {
    mkdirSync(join(home, "Chips", ".bridges", "acp"), { recursive: true });
    writeFileSync(
      join(home, "Chips", ".bridges", "acp", "claude-code.json"),
      JSON.stringify({ name: "Claude Code", command: [AGENT], folders: "~/Chips/Agents/claude-code", env }),
    );
  };
  const kept = () =>
    Object.values(JSON.parse(readFileSync(join(home, ".config/chips/harness-keys.json"), "utf8")) as Record<string, string>).map(
      (record) => JSON.parse(record) as { harnessId: string; hello: string },
    );
  const hellos = async (spaceId: string) => (await chips.said(spaceId)).filter((each) => HELLO.test(each.text));
  const run = (command: string) => chips.run(command, { folder: here, home, path: installed });
  /**
   * The command run to its end: what not being set up stops it with. One that goes on instead (it
   * found nothing to stop for, and joined) fails here within a minute and is stopped, so no bridge
   * is left running to hold the test open.
   */
  const stopped = async (command: string, says: RegExp, path?: string) => {
    const running = chips.run(command, { folder: here, home, ...(path === undefined ? {} : { path }) });
    try {
      const still = new Promise<"still running">((done) => setTimeout(done, 60_000, "still running").unref());
      assert.equal(await Promise.race([running.exited, still]), 1, running.output());
      assert.match(running.output(), says);
      assert.ok(running.output().includes(STILL_GOOD), running.output());
      assert.equal((await chips.request(card.requestId)).state, "allowed", "the link is still good");
    } finally {
      await running.stop();
    }
  };

  before(async () => {
    chips = await scratchChips();
    home = mkdtempSync(join(tmpdir(), "chips-acp-home-"));
    card = await chips.card("claude-code");
    // The agent's ACP adapter, installed its own way: here, the fake agent under a name of its own.
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, AGENT),
      `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(here, "test", "stdio-agent.ts")}"\n`,
    );
    chmodSync(join(bin, AGENT), 0o755);
    installed = `${bin}${delimiter}${process.env["PATH"] ?? ""}`;
    // Claude Code itself, as the bridge looks for it: a `claude` on the PATH, which it never runs.
    claudeOnly = join(home, "claude-only");
    mkdirSync(claudeOnly);
    writeFileSync(join(claudeOnly, "claude"), "#!/bin/sh\necho 'the stand-in claude is never run' >&2\nexit 1\n");
    chmodSync(join(claudeOnly, "claude"), 0o755);
  });

  after(async () => {
    await chips?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it("stops on each thing not set up, and leaves the link good", async () => {
    // No config: Claude Code's own. On a PATH of node and the system's, Claude Code isn't installed,
    // which is asked first, with its maker's line.
    const bare = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    await stopped(
      card.command,
      /Claude Code isn't installed on this machine: run `curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash`\./,
      bare,
    );
    // Claude Code there and its adapter not: the bridge fetches none for Claude Code, and says how to.
    await stopped(
      card.command,
      /Claude Code's command, claude-agent-acp, isn't on this machine's PATH: install it with `npm install -g @agentclientprotocol\/claude-agent-acp`/,
      `${claudeOnly}${delimiter}${bare}`,
    );
    config({});
    await stopped(card.command, new RegExp(`Claude Code's command, ${AGENT}, isn't on this machine's PATH`));
    config({ FAKE_AGENT_AUTH: "out" });
    await stopped(card.command, /Claude Code isn't signed in on this machine: sign it in its own way \(Fake sign-in\)\./, installed);
    config({ FAKE_AGENT_AUTH: "in" });
  });

  it("joins with what the card grants, and says hello once in its room", async () => {
    // The fake agent, signed in, whatever the stops above left: never this machine's real Claude Code.
    config({ FAKE_AGENT_AUTH: "in" });
    const running = run(card.command);
    try {
      const request = await chips.until("the link taken up", async () => {
        const read = await chips.request(card.requestId);
        return read.state === "redeemed" && read;
      });
      assert.ok(request.harness_id !== undefined && request.space_id !== undefined);
      assert.deepEqual([...(await chips.capabilities(request.harness_id))].sort(), [...card.capabilities].sort());
      await chips.until("its hello", async () => (await hellos(request.space_id!)).length > 0);
      await running.saw(CONNECTED);
      assert.equal((await hellos(request.space_id)).length, 1);
      // Marked said once it is: the key it kept is the one the link handed it.
      await chips.until("its hello marked said", async () => kept()[0]?.hello === "said");
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
    } finally {
      await running.stop();
    }
  });

  it("started again with the same command, says nothing more", async () => {
    const { space_id } = await chips.request(card.requestId);
    const running = run(card.command);
    try {
      await running.saw(CONNECTED);
      // Its hello, were it to say one, comes straight after.
      await new Promise((done) => setTimeout(done, 1500));
      assert.equal((await hellos(space_id!)).length, 1, running.output());
    } finally {
      await running.stop();
    }
  });

  it("takes up a new link in place of the key it kept, and says hello in the new room", async () => {
    const first = await chips.request(card.requestId);
    const again = await chips.card("claude-code");
    const running = run(again.command);
    try {
      const request = await chips.until("the new link taken up", async () => {
        const read = await chips.request(again.requestId);
        return read.state === "redeemed" && read;
      });
      assert.notEqual(request.harness_id, first.harness_id);
      await chips.until("its hello in the new room", async () => (await hellos(request.space_id!)).length === 1);
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
    } finally {
      await running.stop();
    }
  });
});

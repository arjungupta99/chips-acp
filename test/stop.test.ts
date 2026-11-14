/**
 * A stop while the bridge is still starting, as `kill` or the service that keeps it running sends
 * one. The bridge is run as it runs for real, `src/main.ts` as a process of its own, with a key it
 * kept before, and is stopped while it waits for a Chips that is down, and while its agent hasn't
 * said hello. Either way what the start had opened is closed first: a stop used to be heard only
 * once the start was done, and one before then left its agent running and nothing saved. A start
 * that was stopped still ends as the signal, so `chips connect`, which reads an exit of 0 as
 * connected, never takes it for one that worked; once it has started, a stop is a clean end.
 *
 * Nothing of this machine's is read or written: its home, its config and its key are in a folder
 * made for the test, and Chips is the conformance kit's fake.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type FakeChips, startFakeChips } from "@chipschat/conformance";
import { join as joinChips } from "@chipschat/harness";

const here = join(import.meta.dirname, "..");

/** An agent that starts, says which process it is, and never says hello: the start waits for it. */
const SILENT = [process.execPath, "-e", "process.stderr.write(`up ${process.pid}\\n`); setInterval(() => {}, 1000);"];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Once `check` holds, looked at every few milliseconds; `why` it didn't is said when it never does. */
async function until(check: () => boolean, why: () => string, ms = 15_000): Promise<void> {
  for (const by = Date.now() + ms; !check(); await new Promise((done) => setTimeout(done, 10))) {
    if (Date.now() > by) assert.fail(why());
  }
}

/** An agent that says hello and answers, as a real one does: the start gets to its end. */
const ANSWERS = [process.execPath, "--import", import.meta.resolve("tsx"), join(here, "test", "stdio-agent.ts")];

/** A home of its own for the bridge, with the key a first run keeps and its config, `fakey.json`. */
async function scratch(chips: FakeChips, command: readonly string[] = SILENT) {
  const home = mkdtempSync(join(tmpdir(), "chips-acp-stop-"));
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    CHIPS_URL: chips.address.url,
    CHIPS_CONFIG_HOME: join(home, "config"),
    CHIPS_NO_KEYCHAIN: "true",
    CHIPS_KEEP: "off",
  };
  await joinChips({ link: chips.makeJoinLink(["agents"]), name: "Fakey", env });
  const config = join(home, "fakey.json");
  writeFileSync(config, JSON.stringify({ name: "Fakey", command, folders: join(home, "agents") }));
  return { home, env, config, kept: join(home, "fakey") };
}

/** `src/main.ts` as a process: what it has said, a stop sent to it, and how it ended. */
function run(config: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", config], {
    cwd: here,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (said += String(data)));
  let over = false;
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => {
      over = true;
      done({ code, signal });
    });
  });
  return {
    said: () => said,
    ended,
    /** What it said that matches, once it has; failing, with what it said, when it ended first or never did. */
    saw: async (what: RegExp) => {
      await until(() => what.test(said) || over, () => `it never said ${what}:\n${said}`);
      const found = what.exec(said);
      assert.ok(found !== null, `it ended before it said ${what}:\n${said}`);
      return found;
    },
    stop: () => child.kill("SIGTERM"),
    /** However the test went, no bridge is left running. */
    gone: () => {
      if (!over) child.kill("SIGKILL");
      return ended;
    },
  };
}

it("ends as the signal when it is stopped while it waits for Chips, not as a start that worked", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"], harnessName: "Fakey" });
  const { home, env, config } = await scratch(chips);
  // Chips is down, and this is the copy the machine keeps running, which waits for it.
  await chips.close();
  const bridge = run(config, { ...env, XPC_SERVICE_NAME: "chat.chips.acp.fakey" });
  try {
    await bridge.saw(/waiting for Chips/);
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
  } finally {
    await bridge.gone();
    rmSync(home, { recursive: true, force: true });
  }
});

it("stops its agent and saves what it keeps when it is stopped while it starts", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"], harnessName: "Fakey" });
  const { home, env, config, kept } = await scratch(chips);
  const bridge = run(config, env);
  let agent = 0;
  try {
    // Its agent is running and hasn't said hello: the bridge is connected, and still starting.
    agent = Number((await bridge.saw(/Fakey: up (\d+)/))[1]);
    // What the SDK keeps is saved by the stop itself: taken away here, it is written again.
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
    await until(() => !alive(agent), () => "its agent is still running");
  } finally {
    await bridge.gone();
    if (agent > 0 && alive(agent)) process.kill(agent, "SIGKILL");
    await chips.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("ends cleanly, with what it keeps saved, when it is stopped once it has started", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"], harnessName: "Fakey" });
  const { home, env, config, kept } = await scratch(chips, ANSWERS);
  const bridge = run(config, env);
  try {
    await bridge.saw(/connected as /);
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: 0, signal: null }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
  } finally {
    await bridge.gone();
    await chips.close();
    rmSync(home, { recursive: true, force: true });
  }
});

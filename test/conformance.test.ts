/**
 * The conformance kit's golden scenario, played against the bridge with an ACP agent in this
 * process: what `chips conformance custom --capabilities agents,restarts` checks of it live.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { formatReport, runConformance } from "@chips/conformance";
import { type Chips, connect } from "@chips/harness";
import { Bridge } from "../src/bridge.ts";
import { fakeAgent } from "./fake-agent.ts";

it("passes the golden scenario", async () => {
  let client: Chips | undefined;
  let bridge: Bridge | undefined;
  const agent = fakeAgent({ askFirst: true });
  const report = await runConformance({
    beatTimeoutMs: 3000,
    subject: {
      name: "chips-acp",
      capabilities: ["agents", "restarts"],
      start: async (address) => {
        client = await connect({ url: address.url, token: address.token });
        bridge = new Bridge({
          chips: client,
          agents: [{ name: "Fakey", command: ["fake"], cwd: mkdtempSync(join(tmpdir(), "chips-acp-")) }],
          home: address.spaceId,
          state: { sessions: {} },
          saveState: () => undefined,
          wireFor: () => agent.wire(),
        });
        await bridge.start();
      },
      stop: async () => {
        bridge?.stop();
        client?.close();
      },
    },
  });
  assert.ok(report.passed, formatReport(report).join("\n"));
  assert.deepEqual(
    report.findings.filter((finding) => finding.severity !== "note"),
    [],
    formatReport(report).join("\n"),
  );
});

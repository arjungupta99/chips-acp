/**
 * The fake agent as a process of its own, speaking ACP over its stdin and stdout. Signed out with
 * `FAKE_AGENT_AUTH=out`, and refusing sessions too with `FAKE_AGENT_REFUSES=1`.
 */

import { createInterface } from "node:readline";
import { fakeAgent } from "./fake-agent.ts";

const auth = process.env["FAKE_AGENT_AUTH"];
const wire = fakeAgent({
  ...(auth === "in" || auth === "out" ? { auth } : {}),
  refusesSessions: process.env["FAKE_AGENT_REFUSES"] === "1",
}).wire();
wire.onLine((line) => process.stdout.write(`${line}\n`));
wire.onClose(() => process.exit(1));
createInterface({ input: process.stdin }).on("line", (line) => wire.write(line));
process.stderr.write("fake agent up\n");

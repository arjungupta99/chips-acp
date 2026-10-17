/**
 * One ACP agent, as a process this bridge runs: JSON-RPC 2.0, a message per line, over the
 * agent's stdin and stdout (the Agent Client Protocol's stdio transport, v1). The bridge is the
 * client: it calls `initialize`, `session/new`, `session/load`, `session/fork`, `session/close`,
 * `session/prompt`, `session/set_mode`, `session/set_config_option`, and notifies `session/cancel`; the agent notifies `session/update`
 * and asks `session/request_permission` and `elicitation/create`, which the bridge answers.
 *
 * The client offers the agent no file system and no terminal: the agent works with its own tools,
 * under its own permissions, and each permission it asks for is a Chips approval.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ACP_VERSION = 1;

/** A JSON-RPC id. */
type Id = number | string;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AcpError extends Error {
  override readonly name = "AcpError";
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** What the agent said about itself at `initialize`. */
export interface AgentInfo {
  readonly protocolVersion: number;
  readonly loadSession: boolean;
  /** Whether it closes a session it was asked to (`session/close`), so idle ones can be let go. */
  readonly closeSession: boolean;
  /** Whether it copies a session (`session/fork`): what Fork in Chips needs. */
  readonly forkSession: boolean;
  readonly images: boolean;
  readonly authMethods: readonly { readonly id: string; readonly name: string }[];
  /** Whether it says who it is signed in as (`_auth/status_update`), as Claude Code's and Codex's do. */
  readonly reportsAuth: boolean;
  readonly name?: string | undefined;
}

/** Who the agent says it is signed in as: `none` is signed out. */
export interface AuthStatus {
  readonly kind: string;
  readonly label?: string | undefined;
}

/** The refusal ACP gives a session or a turn while the agent isn't signed in (`authRequired`). */
export function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpError && error.code === -32000 && /auth/i.test(error.message);
}

/** One of `session/update`'s kinds, as the agent sent it. */
export type SessionUpdate = Readonly<Record<string, unknown>> & {
  readonly sessionUpdate: string;
};

/** The agent asking the client something: permission, a form, or something this client lacks. */
export interface AgentRequest {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface AcpHandlers {
  readonly update: (sessionId: string, update: SessionUpdate) => void;
  /** Answer the agent; throw an `AcpError` to refuse. */
  readonly request: (request: AgentRequest) => Promise<unknown>;
  /** The process went away, with how it ended. */
  readonly exit: (why: string) => void;
  /** Who it is signed in as, when it says (after `initialize`, and when that changes). */
  readonly auth?: (status: AuthStatus) => void;
}

/** A line-delimited JSON-RPC peer over two streams: the process's, or a test's. */
export interface Wire {
  readonly write: (line: string) => void;
  readonly onLine: (handler: (line: string) => void) => void;
  readonly onClose: (handler: (why: string) => void) => void;
  readonly close: () => void;
}

/** The wire over a child process: `command` run in `cwd`, its stderr kept for the log. */
export function processWire(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Wire {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("an agent needs a command");
  const child: ChildProcess = spawn(program, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on("line", log);
  const closers: ((why: string) => void)[] = [];
  let gone = false;
  const end = (why: string) => {
    if (gone) return;
    gone = true;
    for (const closer of closers) closer(why);
  };
  child.on("exit", (code, signal) => end(signal === null ? `exited ${code}` : `killed by ${signal}`));
  child.on("error", (error) => end(error.message));
  return {
    write: (line) => {
      if (!gone) child.stdin?.write(`${line}\n`);
    },
    onLine: (handler) => lines.on("line", handler),
    onClose: (handler) => closers.push(handler),
    close: () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    },
  };
}

/** An ACP connection to one agent. */
export class AcpClient {
  private next = 1;
  private readonly pending = new Map<Id, Pending>();
  private closed = false;

  constructor(
    private readonly wire: Wire,
    private readonly handlers: AcpHandlers,
  ) {
    wire.onLine((line) => this.hear(line));
    wire.onClose((why) => {
      this.closed = true;
      for (const [, waiting] of this.pending) waiting.reject(new AcpError(`the agent ${why}`, -32000));
      this.pending.clear();
      handlers.exit(why);
    });
  }

  /** Say hello, and learn what the agent can do. */
  async initialize(client: { name: string; version: string }): Promise<AgentInfo> {
    const answer = (await this.call("initialize", {
      protocolVersion: ACP_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: client,
    })) as Record<string, unknown>;
    const capabilities = (answer["agentCapabilities"] ?? {}) as Record<string, unknown>;
    const prompts = (capabilities["promptCapabilities"] ?? {}) as Record<string, unknown>;
    const info = (answer["agentInfo"] ?? {}) as Record<string, unknown>;
    const sessions = (capabilities["sessionCapabilities"] ?? {}) as Record<string, unknown>;
    const meta = (capabilities["_meta"] ?? {}) as Record<string, unknown>;
    return {
      protocolVersion: Number(answer["protocolVersion"] ?? ACP_VERSION),
      loadSession: capabilities["loadSession"] === true,
      closeSession: sessions["close"] !== undefined && sessions["close"] !== null,
      forkSession: sessions["fork"] !== undefined && sessions["fork"] !== null,
      images: prompts["image"] === true,
      authMethods: Array.isArray(answer["authMethods"])
        ? (answer["authMethods"] as { id: string; name: string }[])
        : [],
      reportsAuth: meta["authStatus"] !== undefined && meta["authStatus"] !== null,
      ...(typeof info["name"] === "string" ? { name: info["name"] } : {}),
    };
  }

  /** A new session in `cwd`. Answers with its id and anything it said it can be set to. */
  async newSession(
    cwd: string,
    mcpServers: readonly unknown[] = [],
  ): Promise<{ sessionId: string; configOptions: readonly ConfigOption[] }> {
    const answer = (await this.call("session/new", { cwd, mcpServers })) as Record<string, unknown>;
    return { sessionId: String(answer["sessionId"]), configOptions: configOptionsOf(answer) };
  }

  /** A session it had before, back: its history comes as `session/update`s first. */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: readonly unknown[] = [],
  ): Promise<{ configOptions: readonly ConfigOption[] }> {
    const answer = (await this.call("session/load", { sessionId, cwd, mcpServers })) as
      | Record<string, unknown>
      | null
      | undefined;
    return { configOptions: configOptionsOf(answer ?? {}) };
  }

  /** A copy of a session, remembering everything it does, working in `cwd`. Answers with the copy's id. */
  async forkSession(sessionId: string, cwd: string, mcpServers: readonly unknown[] = []): Promise<string> {
    const answer = (await this.call("session/fork", { sessionId, cwd, mcpServers })) as Record<string, unknown>;
    if (typeof answer["sessionId"] !== "string") throw new AcpError("the agent copied the session and named no copy", -32000);
    return answer["sessionId"];
  }

  /** Let a session go: the agent keeps it, and `session/load` brings it back. */
  async closeSession(sessionId: string): Promise<void> {
    await this.call("session/close", { sessionId });
  }

  /** The session's mode, one of those it offers: Claude Code's `default`, Codex's `workspace-write`. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.call("session/set_mode", { sessionId, modeId });
  }

  /** One turn: resolves with why it stopped, once the agent has finished it. */
  async prompt(sessionId: string, prompt: readonly unknown[]): Promise<string> {
    const answer = (await this.call("session/prompt", { sessionId, prompt })) as Record<
      string,
      unknown
    >;
    return String(answer["stopReason"] ?? "end_turn");
  }

  /** Stop the session's turn: its prompt then answers `cancelled`. */
  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  /** Set one of the session's options: its model, how hard it thinks, its mode. */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<readonly ConfigOption[]> {
    const answer = (await this.call("session/set_config_option", { sessionId, configId, value })) as
      | Record<string, unknown>
      | null
      | undefined;
    return configOptionsOf(answer ?? {});
  }

  close(): void {
    this.closed = true;
    this.wire.close();
  }

  get gone(): boolean {
    return this.closed;
  }

  private call(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpError("the agent is not running", -32000));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.wire.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private notify(method: string, params: Readonly<Record<string, unknown>>): void {
    if (!this.closed) this.wire.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private hear(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // A line that is not JSON is the agent talking to itself.
    }
    const id = message["id"] as Id | undefined;
    const method = message["method"];
    if (typeof method === "string") {
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      if (id === undefined) {
        this.notified(method, params);
        return;
      }
      void this.answer(id, { method, params });
      return;
    }
    if (id === undefined) return;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);
    const error = message["error"] as { code?: number; message?: string; data?: unknown } | undefined;
    if (error !== undefined) {
      waiting.reject(new AcpError(error.message ?? "the agent refused", error.code ?? -32000, error.data));
      return;
    }
    waiting.resolve(message["result"]);
  }

  private notified(method: string, params: Readonly<Record<string, unknown>>): void {
    if (method === "_auth/status_update") {
      const status = params["authStatus"] as Record<string, unknown> | undefined;
      if (typeof status?.["kind"] !== "string") return;
      this.handlers.auth?.({
        kind: status["kind"],
        ...(typeof status["label"] === "string" ? { label: status["label"] } : {}),
      });
      return;
    }
    if (method !== "session/update") return;
    const update = params["update"] as SessionUpdate | undefined;
    if (update === undefined || typeof update.sessionUpdate !== "string") return;
    this.handlers.update(String(params["sessionId"]), update);
  }

  private async answer(id: Id, request: AgentRequest): Promise<void> {
    try {
      const result = await this.handlers.request(request);
      this.wire.write(JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null }));
    } catch (error) {
      const code = error instanceof AcpError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      this.wire.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    }
  }
}

/** A session option the agent offers, such as its model (`category: "model"`). */
export interface ConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category?: string | undefined;
  readonly currentValue: string;
  readonly options: readonly { readonly value: string; readonly name: string }[];
}

function configOptionsOf(answer: Readonly<Record<string, unknown>>): ConfigOption[] {
  const raw = answer["configOptions"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((each) => {
    const option = each as Record<string, unknown>;
    if (typeof option["id"] !== "string" || !Array.isArray(option["options"])) return [];
    return [
      {
        id: option["id"],
        name: typeof option["name"] === "string" ? option["name"] : option["id"],
        ...(typeof option["category"] === "string" ? { category: option["category"] } : {}),
        currentValue: String(option["currentValue"] ?? ""),
        options: (option["options"] as Record<string, unknown>[]).map((value) => ({
          value: String(value["value"]),
          name: String(value["name"] ?? value["value"]),
        })),
      },
    ];
  });
}

/** The JSON-RPC answer for a method this client does not offer. */
export function notOffered(method: string): AcpError {
  return new AcpError(`${method} is not offered by this client`, -32601);
}

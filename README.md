# chips-acp

An agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) — Claude
Code, Codex, Goose, Gemini — as a Chips harness, one kind per harness. People make its agents from
Chips: a room from the +, a new agent from a room's Add page, a copy with Fork. Each agent works in a
folder of its own; each room it is in is one ACP session of it. There is no Main agent. The bridge
runs the agent's process, so the bridge is the harness (Chips ADR 0041), built on `@chipschat/harness`.
Phase 4 of Chips's `docs/proposals/open-source-harnesses-plan.md`, and Chips's
`docs/proposals/acp-agents-made-from-chips-plan.md`.

The `@chipschat/*` SDK packages come from npm, at the version `package.json` pins, and the build
bundles them into `dist/main.js`.

## From Chips's gallery

The card's line is `CHIPS_JOIN_LINK='<link>' chips connect claude-code` or `CHIPS_JOIN_LINK='<link>' chips connect codex` (Chips ADR 0218). It downloads this bridge as the npm package
`@chipschat/acp`, the newest 1.x, checks it against the registry's checksum, and runs it on the Node
that Chips carries, so the machine needs no Node or npm of its own. The agent itself is the person's to install from its maker and to sign in to. The bridge asks for it first, then fetches Codex's ACP adapter when it isn't on the PATH, with the npm Chips carries, into `~/Chips/.bridges/acp/adapters/codex` (Chips ADR 0288). Claude Code's adapter is still installed by hand until Anthropic has said whether a product like Chips may fetch it. The bridge checks the agent's sign-in,
joins, and keeps itself running from login. `chips disconnect claude-code` or `chips disconnect codex` stops it. Claude Code and Codex share this one package: their cards hand it `~/Chips/.bridges/acp/claude-code.json` or `codex.json`, and the file's name picks the kind. On another computer,
`curl -fsSL https://chipschat.ai/install | CHIPS_JOIN_LINK='<link>' sh -s -- connect claude-code` installs Chips there
first. The steps below run the bridge from this checkout instead, to work on it.

## Run it

```bash
npm install -g @agentclientprotocol/claude-agent-acp   # or @agentclientprotocol/codex-acp
npm install
CHIPS_JOIN_LINK='<a join link made in Chips>' npm run keep ~/Chips/.bridges/acp/claude-code.json
```

`npm run keep` joins, then keeps the bridge running from login ("Keep it running", below);
`npm start` is the same in the terminal only.

The link comes from Chips's gallery (Agents → Connect a harness → Claude Code, or Codex), whose card gives this
line with the link in it (`codex.json` for Codex) and starts the link with what it needs on:
`agents`, `new_spaces`, `new_agents`, `forks` and `restarts`. `claude-code.json` and `codex.json`
need not be there: without them the bridge runs Claude Code or Codex, in the mode that asks (see
"Asking a person"), with each agent's folder under `~/Chips/Agents/claude-code` or `~/Chips/Agents/codex`.

Before it takes the link up, which works once, it checks:
- the config is there, or is one of those two;
- its command is on this machine's PATH (else how to install it);
- the agent starts, makes a session, and is signed in: Codex refuses a session while signed out,
  and Claude Code says it is signed in as nobody (`_auth/status_update`). Signed out, it says how
  to sign in: `codex login`, or `claude` then /login.

Anything missing stops it with what to do, and the link is still good. Joined, it says hello in its
room once, which the card waits for; a new link from Chips replaces the key it kept. Without a
link, set `CHIPS_URL` and allow the code it prints from Chips. Its key is kept as `join()` keeps
one (the keychain, under the kind's name); its cursor, unanswered events, unended runs, its agents
and which session each of their rooms is are kept in a folder beside the config, named after it
(`~/Chips/.bridges/acp/claude-code/`), so a restart picks up where it was. Each start logs whether the
agent says it is signed in, and a turn it refuses for that says how to sign in.

The config names one kind:

```json
{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default", "folders": "~/Chips/Agents/claude-code" }
```

- `name` is the harness's name in Chips, and its own agent's.
- `command` is how the agent speaks ACP over stdio: `["claude-agent-acp"]`, `["codex-acp"]`,
  `["goose", "acp"]`, `["gemini", "--acp"]`, `["opencode", "acp"]`.
- `folders` is where each agent gets a folder of its own, named after it (`~/Chips/Agents/claude-code/nova`),
  made empty. A copy from Fork works on in its original's folder, with the files the conversation it
  remembers expects. A deleted agent's folder stays.
- `folder`, in its place, puts every agent in one folder: a repository they work on together.
- `mode` is the mode its sessions are put in, of those the agent offers (see below). `env` adds to
  its environment.

Everything it keeps is under `~/Chips` (Chips ADR 0283): the configs and what each kind keeps in
`~/Chips/.bridges/acp`, the agents' folders in `~/Chips/Agents`. Until 1.0.13 they were
`~/.chips-acp` and `~/chips-acp`. A kind moves what it had there the first time 1.0.13 starts: its
config and what it keeps, its agents' folders (where its config named the old place, or nothing),
the folder paths it saved, and Claude Code's own store for each folder that moved
(`~/.claude/projects/<the folder's path, dashed>`), which holds the folder's conversations and memory.
It renames and never copies; where something is at the new place already it moves in what isn't
there yet and says in its log what it left. A config path in the old place, from an older Chips's
card or a login item kept before, is read in the new one, and the login item is kept with the new
path.

Installing any other agent and signing it in to a model is done the agent's own way, before it is
named here. A second kind is a second config, and a second bridge beside the first.

### Its agents

- **The + in Chips**, with the harness's face: the room is claimed, named from the first words, and
  a new agent (Chips names it) answers them.
- **Add on a room → a new agent**: an agent called what the person asked joins the room.
- **Fork**: the agent's session in the room it is in is copied (`session/fork`), and the copy
  remembers everything up to then. One that never spoke is copied fresh.
- **The harness's own room** has the agent Chips gives every harness, named after it: an ordinary
  agent, which a person can move anywhere.
- A session quiet for 30 minutes is closed (`session/close`) and loaded again on the next word,
  where the agent offers both: each open Claude Code session is a process of its own.

### Keep it running

`npm run keep <config>` does what `npm start <config>` does, with the link or without, then writes
a launch agent, `~/Library/LaunchAgents/chat.chips.acp.<config's name>.plist` (a systemd user unit
on Linux), that runs the bridge from login and again whenever it stops, and ends. Its log is
`~/Library/Logs/chips-acp-<config's name>.log`; `npm run keep -- <config> --stop` stops it and
removes the file. A launch agent of that name written by hand is left as it is, so a harness never
runs twice:

```bash
launchctl kickstart -k gui/$(id -u)/chat.chips.acp.claude-code   # restart one
```

Stop any copy started by hand first: two bridges for one harness answer twice.

### Asking a person

Claude Code's and Codex's adapters start each session in a mode where the agent decides for
itself: Claude Code's `auto`, Codex's `agent` ("Auto review", where Codex's own reviewer answers
its asks). Then nothing reaches Chips as a card. Put them where they ask:

```json
{ "name": "Claude Code", "command": ["claude-agent-acp"], "mode": "default" }
{ "name": "Codex", "command": ["codex-acp"], "mode": "workspace-write" }
```

- Claude Code still follows its own settings (`~/.claude/settings.json`). What they allow, it
  does without asking, and read-only commands never ask.
- Codex in `workspace-write` changes its folder freely and asks before the network or anything
  outside it. `read-only` asks before any change.

## Live

14 October 2026, on Chips's live server: Claude Code (`@agentclientprotocol/claude-agent-acp`
0.90.0, on its own sign-in) and Codex (`@agentclientprotocol/codex-acp` 2.2.2, on a ChatGPT
sign-in). Each took turns with steps, the gauge and the reply. Claude Code's cost came with its
turns; Codex's didn't, as on a ChatGPT sign-in its adapter reports none. An approval went round
from each, asked, approved in Chips, the call run, and said so. Chips's
`testing/scenarios/harnesses/acp-agents-live.md` has the run.

Later that night, one harness per kind (`~/.chips-acp/claude-code.json`, `codex.json`, launch
agents `chat.chips.acp.claude-code` and `chat.chips.acp.codex`), for each: a room from the +
claimed and answered by a new agent in its own folder; a new agent from Add; a Fork whose copy
remembered what came before and whose original didn't hear the copy; the harness's own agent
moved out of its room; the copy deleted, its folder kept; and a session closed after 30 quiet
minutes and loaded again with its memory. Fourteen runs, none failed, $0.35, all Claude Code's.

## What maps to what

| Chips | ACP |
|---|---|
| A message for an agent | `session/prompt` with the room note and who said it (`promptFor`), files saved under `<folder>/chips-files/` |
| The room | a session in the agent's folder: `session/new` the first time, `session/load` after a restart or an idle close where the agent offers it |
| A room from the + | `claimSpace` under a new key; Chips makes its agent; the first words are its first prompt |
| A new agent (Add) | a record and a folder, registered with `madeFor` and the room |
| Fork | `session/fork` of the original's session in its room, in its folder; the copy registered with `forkedFrom` |
| An agent deleted | its sessions closed (`session/close`), its record forgotten; its folder stays |
| The run | the prompt's turn; `stopReason` ends it (`refusal` fails it, `max_tokens` adds a follow-up) |
| Status | `agent_thought_chunk`, a line at most every 1.5 s |
| Steps | `tool_call` / `tool_call_update` by `toolCallId`, titled with the tool's name or kind |
| Plan | `plan` |
| Context gauge, cost | `usage_update` (`used`/`size`; `cost` in USD, the turn's share) |
| The reply | `agent_message_chunk`s gathered into one message; `NO_REPLY` alone is the turn passed |
| Files in the reply | each `MEDIA:<path>` line of the reply sent as an upload with its words, only from the agent's folder (`sendAnswer`); the post says why one could not go |
| Approval card | `session/request_permission`, asked in the agent's own words where the call has a `description` (Claude Code's commands: "Syntax-check game.js? `node --check game.js`"), else "Allow it to" and the call's title; allowed always picks `allow_always`, except for a command, which picks `allow_once` since Chips remembers it by how each part starts (Chips ADR 0239); no picks `reject_once`; Stop answers `cancelled`; the card hears how the call went |
| Question card | `elicitation/create` form of up to four choice or yes/no fields; anything else is declined; Stop answers `cancel` |
| Stop | `session/cancel` |
| Pause (Chips ADR 0293) | each run says `pausable: true` as it starts; Pause is `session/cancel` with the run kept and nothing posted, and Resume the next prompt of the same session: "You were paused partway through this. Carry on from where you stopped. Nothing you wrote before the pause reached the room, so write your whole reply.", then anything steered meanwhile. A Pause before a prompt holds it; one while an approval or question card waits stops nothing, and the answer reaches the agent on Resume |
| Steer | the next prompt of the same run, after `session/cancel` when it interrupts; the words it was cut off in are dropped, so the reply is one answer |
| Not right? (Chips ADR 0200) | a `correction`, or an older device's 👎: one more turn of the agent who said the reply (by its id in the room's lines), in that room's session, quoting its reply and what was wrong; the run is *Looking again: …*; a 👍 or any other reaction is nothing, and each is answered once |
| Restart | the agent's process stopped and run again |
| Trouble | the agent not running; it is run again after 2 s, longer each time it fails to start |

The agent is offered no file system and no terminal: it works with its own tools, under its own
permissions, and each permission it asks for is an approval card.

### What Chips shows on an agent's page

The bridge says `context` and `models` (Claude Code and Codex) and `context_windows` (every kind)
in its hello, and sends each agent's copies when it starts and as they change. Chips draws them
where the harness is granted `context_files`, `models` and `context_windows`.

| Chips | Claude Code | Codex | Another kind |
|---|---|---|---|
| Context: its own files | its folder's `CLAUDE.md`, and `CLAUDE.local.md`, `.claude/CLAUDE.md` and `.claude/rules/*.md` where they are; its memory, `~/.claude/projects/<its folder>/memory/MEMORY.md`, which Claude Code writes too. A person may change each, and one not there yet shows empty | its folder's `AGENTS.override.md`, else its `AGENTS.md`; a person may change it | none |
| Context: shared | `~/Chips/Agents/claude-code/CLAUDE.md`, read by every agent, changed on the harness's page; files above the agents' folders and `~/.claude/CLAUDE.md`, shown and not changed, since they aren't only these agents' | `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`, shown and not changed | none |
| When it reads them | when a session starts; an edit closes the agent's sessions before its next turn and loads them again, so it applies from the next message | the same | |
| Context window | `usage_update` of the agent's session that said last; the window from the update that ends a turn (it carries the cost), as one before may be a default | `usage_update` | `usage_update` |
| Compact now | `/compact` said to that session as a turn of its own, after any turn going there; its words go nowhere; from and to from its tool call's `rawOutput` | the same; to from the `usage_update` it sends as it finishes | where it lists `compact` among its commands |
| Its limit | its own from `autoCompactWindow` in its settings (`modelSettings` per model), about 33,000 tokens short of it; a pick from Chips goes in each session's `_meta.claudeCode.options.settings`, never in a file; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` beats both, and the limit can't be changed then | the bridge's: after a turn that ends at or past it, the bridge compacts that session; off unless picked | as Codex, where it has `compact` |
| Model | the models its adapter offers for a session (the `model` option), each with its levels (`effort`, without its `default`), by the adapter's own names (its `xhigh` is Extra high); Same as "Claude Code's default" is what a new session starts on: `model` in its settings, or its own `default` | the same, with `reasoning_effort`; the default from Codex's config, which may be a model its list leaves out, with no levels | none |
| Where it learns them | each time the bridge starts the agent, a session opened in the harness's folder and put on each model in turn, then closed, with nothing said to it; a model it won't be put on isn't offered | the same | |
| A pick | set on each of the agent's sessions with `session/set_config_option`, now and as each opens after, never in a file; kept with the agent, and a copy from Fork starts with its original's. Same as again puts each back on the default, and its level on Claude Code's `default`, which follows its settings | the same; a session Codex won't put back on a model its list leaves out is let go and loaded again before its next turn | |

An edit is saved only if the file is still what the person read; otherwise it is refused as changed.
The bridge's own Codex adapter runs with `project_doc_max_bytes` at 64 KiB in `CODEX_CONFIG`, laid
over Codex's own config for each session it starts, so Codex reads all of a file Chips lets a person
write (32 KiB unless set).

## Not built yet

From the plan's Phase 4: agents over WebSocket (`goose serve`); `follows_rooms`; models for any
other kind; the bridge's own MCP server (reminders, ask a person) and heartbeats; sub-agents as lanes; free-text form fields; approval scopes limited to the
agent's options (a wire change, Phase 6).

## Tests

```bash
npm test
```

A scripted ACP agent (`test/fake-agent.ts`), in process and as a child process, against the
conformance kit's fake Chips, which checks every event against the protocol's schemas; and the kit's
golden scenario with the +, Add and Fork, which
`chips conformance custom --capabilities agents,new_spaces,new_agents,forks,restarts` runs live:
Lives in Chips 5 of 6. Run as Claude Code with `context_files`, `context_windows` and `models`
besides, the kit's settings checks pass: Managed from Chips 3 of 5. `test/settings.test.ts` plays the
files, the windows and the models of each kind, from a home of its own; its models are the ones
Claude Code's adapter 0.90.0 and Codex's 2.2.2 offered on 28 October 2026.

```bash
npm run e2e
```

The gallery's ACP card, run as a person runs it, against a scratch Chips from a Chips checkout
(`CHIPS_REPO`, `~/Work/Chips/chips-main` unless set; skipped without one), with the fake agent installed on the
PATH under a name of its own (never `claude-agent-acp`, which this machine may have for real). Each
thing not set up stops it with the link still good; then it joins with what the card grants, says
hello once in its room, says nothing more started again, and takes up a new link in place of the key
it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`, which packs this checkout and serves it from a stand-in npm registry, so the card's `chips connect` downloads, checks and runs what would be published.

## Release

`npm run release` builds `dist/main.js`, one file with the SDK and everything else bundled in, and
`dist/THIRD-PARTY-NOTICES.md` beside it; runs the tests; and packs `chipschat-acp-<version>.tgz`. To
publish, put the new version in `package.json` (`npm version <version> --no-git-tag-version`), commit
it and push to `main`: GitHub's Publish workflow (`.github/workflows/publish.yml`) tests it and
publishes it to npm, which trusts that workflow, so nobody signs in. Don't also run `npm publish`:
the two race. A version's major is the Chips protocol it speaks, and Chips's card names that major
(Chips ADR 0218): a fix is a minor or a patch, and reaches every card of its major the day it is
published.

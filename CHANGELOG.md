# Changelog

## [0.2.1] - 2026-10-24

### Added

- Pi (Earendil's pi coding agent, 1.4.0+) as a sixth agent: `"adapter": "pi"`. A bundled bridge, `dist/pi-acp.js`, drives the local `pi --mode rpc` per session. Models are `provider/id`, `reasoning_effort` takes pi's thinking levels, `cancel` aborts the turn, reconnecting replays the history, and `delete` removes the session file. pi never asks for approval, so its tools run straight away; limit them with `--tools` in `args`.
- `snapshot` takes `simplify: true` for clients that poll it: tool calls keep only what their collapsed card shows (title, kind, status, paths), and sessions leave out their slash commands. A poll stays small when tool output is large.
- `item` returns one conversation item in full by its id, so a client can fetch a tool call's input, output and diffs when they are opened. An item no longer kept fails with `ITEM_NOT_FOUND`.

## [0.2.0] - 2026-10-23

### Changed

- Breaking: `snapshot` returns each session's full conversation as `items`, the same items the Web UI shows (prompts, replies, thinking, tool calls with their input, output and diffs, plans, approvals, questions and agent-specific messages), each with the `rev` of its last change. `events` and `view` are gone, and `seq` now counts item revisions. New params: `session` for one session, `types` and `exclude_types` for item kinds, `last` for the last few items. Unknown kinds and a `last` below 1 are invalid params.
- `open` with `reuse` also reconnects the latest closed session on disk with the same `cwd` and subagent. A session that fails to reconnect gets a new one instead, `reuse_skipped` says why, and the broken session is not picked again until an explicit reconnect works.
- A session closed by `idle.timeout` comes back on its own at the next `prompt` or `set_config`, with its settings. Until then `status`, `progress` and `output` return what it had (`CLOSED`) instead of `SESSION_NOT_FOUND`. `close` and `delete` end that.
- Web UI: turn dividers show how long the turn took, before the tokens. A turn still running when its session closes or its agent exits ends with a `closed` divider and the reason.
- Web UI: the conversation tab is monospace, with Sarasa Mono SC or Noto Sans Mono CJK SC first, so Chinese lines up with Latin text when one of them is installed.
- The Web UI drops conversation items together with the messages behind them, instead of keeping up to 5000 items apart.

### Added

- `snapshot.truncate_message_size`, `snapshot.max_message_count`, `webui.truncate_message_size` and `webui.max_message_count` in `config.json`: the message size (bytes) shown as a truncation marker above it, and the messages kept per session. Defaults 1048576 and 5000.

### Fixed

- A single newline in a reply, thought, plan or tool output now breaks the line in the Web UI, as in the terminal.
- A tool's status icon sits on the first line of a title that wraps.
- Deleting a session closed earlier, or a delete that fails on an open session, now tells the Web UI and `snapshot` that the session ended.

## [0.1.1] - 2026-10-23

### Changed

- The Web UI's protocol log lists the newest message first.
- The Web UI's turn dividers show the cache hit rate and, for agents that report a context window, the context as the turn left it. Grok turns show their tokens too, read from grok's own `_meta`.
- Antigravity: the bridge passes agy's token usage on in the `session/prompt` result.

### Fixed

- Numbered and bulleted list markers in the Web UI's markdown were larger than the text.
- Reconnecting to a session (after `close`, an idle close or a server restart) brought it back on the agent's own defaults, so `model`, `reasoning_effort`, `mode` and any `set_config` changes were lost without a word. Sessions now keep their config in `session.json` and get it back on reconnect, `model` first. Sessions saved by 0.1.0 get the subagent config.

## [0.1.0] - 2026-10-21

### Added

- MCP server over stdio that drives Codex through `@agentclientprotocol/codex-acp` 2.2.2 and Claude Code through `@agentclientprotocol/claude-agent-acp` 0.93.0.
- Grok Build adapter: the local `grok` (1.0.46 or later) speaks ACP itself and runs as `grok agent --no-leader <args> stdio`. `mode` does not apply to Grok; its permission mode comes from grok's config or `args`. `delete` goes through grok's own `_x.ai/session/delete`, since grok does not implement ACP `session/delete`.
- OpenCode adapter: the local `opencode` (2.0.30 or later, the Homebrew line) speaks ACP itself and runs as `opencode acp <args>`. `model`, `reasoning_effort` and `mode` set its `model`, `effort` and `mode` (`build` or `plan`) options. `reject` ends the turn as `cancelled`, like Grok.
- Google Antigravity adapter through the bundled bridge `dist/agy-acp.js`, which drives the local `agy -p` (1.4.2 or later, Homebrew cask `antigravity-cli`) in stream-json mode. `model`, `reasoning_effort` and `mode` become `--model`, `--effort` and `--mode`; `args` go on the agy command line. agy's headless mode has no approvals or questions: tools that need a permission are denied by agy and the output ends with a note naming them. Reconnecting continues the conversation without replay, and `delete` is `unsupported` natively since agy cannot delete a conversation.
- Settings pass through untranslated: the subagent `env` reaches the agent as written, including `DEFAULT_AUTH_REQUEST`, which makes codex-acp log in by itself and save the key in `CODEX_HOME/auth.json`.
- Standalone package: both ACP adapters are bundled into `dist/`, there are no runtime dependencies, and the local `codex` and `claude` programs are used (Homebrew or npm installs). Node.js 22 or later.
- The server finds each agent program (`path`, else `PATH`) and checks its version before a session starts: `AGENT_NOT_FOUND`, `AGENT_VERSION_UNSUPPORTED`.
- `profiles`: subagents build on a shared profile; `env` merges by name and `args` by `--flag`, with the subagent winning. `PROFILE_NOT_FOUND` for a missing profile.
- `env` values may be any JSON value: objects and arrays reach the agent as JSON text (with `${VAR}` filled in first), numbers and booleans as text, and `null` removes the variable like `""`.
- `args` for the agent program, passed to Claude Code and put on the Grok, OpenCode and agy command lines; adapters that cannot take them ignore them with a note on stderr.
- 16 tools: `subagents`, `sessions`, `open`, `prompt`, `approve`, `allow`, `reject`, `answer`, `cancel`, `set_config`, `status`, `progress`, `output`, `close`, `delete`, `snapshot`.
- Agent questions (ACP elicitation, form mode), kept apart from approvals: blocking calls return `question_needed` with the agent's form as sent, `answer` replies with `accept` and `content`, `decline` or `cancel`, and the session state is `QUESTIONING`. Pending approvals come before pending questions.
- `progress` returns the agent's latest plan, context usage, session title and slash commands on demand; `status` does not carry them. `sessions` lists each session's title.
- Every tool declares an `outputSchema` and returns `structuredContent` plus the same JSON as text; bad arguments are JSON-RPC `-32602` errors.
- Blocking calls have no server-side limit. A client-side timeout or cancellation withdraws the waiter without cancelling the agent turn; `status` and `output` pick up the result.
- Progress notifications every 60s during blocking calls that carry a `progressToken`, so Claude Code's 30-minute idle timeout does not cut off long turns.
- `open` only sets up the session and returns its id; tasks go through `prompt`.
- `status` returns current config values only; `open`, `set_config` and `snapshot` carry the full choices.
- Session reuse, reconnect through `session/load` or `session/resume`, idle close (`idle.timeout`, off by default), cross-process ownership through `lock.pid`, native session delete (Codex archives, Claude Code deletes the transcript, Grok and OpenCode delete the session).
- `allow` stays within the session: the server keeps the rule and never picks an agent option that is saved for good (Codex prefix rules, Claude Code `allow-with-updates`, Grok `always-allow`, OpenCode `always`).
- Incremental `snapshot` with delivery tracking for UI clients.
- Read-only web UI at `http://127.0.0.1:7200` for every session on the machine: conversation, tool calls, plans, approvals, questions and the raw ACP messages. The first MCP server starts it, all servers share it, and it exits about 10 seconds after the last one. Data stays in memory. `webui.port` or `SUBAGENT_COCKPIT_WEBUI_PORT` sets the port, `0` turns it off.
- Command line: default `mcp` command, `--transport stdio`, `--version`; unknown commands and options fail.

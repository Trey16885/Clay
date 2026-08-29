# Clay

A terminal AI agent. Clay reads your files, searches them, edits them, and runs
commands — asking before it changes anything — and streams its answer back as it
works.

It is deliberately small: one dependency (the official Anthropic SDK), plain ES
modules, no build step, no framework. The whole agent loop is about 200 lines in
`src/agent.js`, so you can read it in one sitting and change what you don't like.

## Install

```sh
cd clay
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or run `ant auth login`
node bin/clay.js
```

To get `clay` on your PATH:

```sh
npm link
clay
```

Node 18.17 or newer.

## Use it

```sh
clay                                  # interactive session in the current directory
clay "why does the build fail?"       # one task, then exit
clay -C ~/src/app "add a health check endpoint"
git diff | clay -p "review this diff"  # reads the prompt from stdin
```

Useful flags:

| Flag | What it does |
| --- | --- |
| `-C, --cwd <dir>` | Workspace root. Clay cannot read or write outside it. |
| `-m, --model <id>` | Model id. Default `claude-opus-5`. |
| `-e, --effort <level>` | `low`, `medium`, `high`, `xhigh`, `max`. Default `high`. |
| `-y, --yolo` | Stop asking before edits and commands. |
| `--allow-outside` | Lift the workspace sandbox. |
| `--no-web` | Drop the hosted web search tool. |
| `-p, --print` | Non-interactive: answer once and exit. |
| `-q, --quiet` | Hide the tool-call trace. |

`CLAY_MODEL` and `CLAY_EFFORT` set the defaults; `NO_COLOR` turns off colour.

## In a session

```
/help            list these
/reset           forget the conversation
/compact         replace the history with a summary of it
/cost            tokens used and estimated spend
/model [id]      show or switch the model
/effort [level]  show or set effort
/yolo            toggle approval prompts
/tools           list the tools Clay can use
/cwd             show the workspace root
/save [file]     write the transcript to JSON
/exit            quit
```

Ctrl-C interrupts whatever Clay is doing; at an idle prompt it ends the session,
as does Ctrl-D.

## Tools

| Tool | Asks first | What it does |
| --- | --- | --- |
| `read_file` | no | Reads a text file with line numbers, with offset/limit for big ones. |
| `list_files` | no | Lists a directory, skipping `.git`, `node_modules` and friends. |
| `search_files` | no | Regex search across the workspace, with an optional glob filter. |
| `write_file` | yes | Creates a file or replaces it wholesale. |
| `edit_file` | yes | Replaces an exact string; refuses ambiguous matches. |
| `run_command` | yes | Runs a bash command in the workspace, with a timeout. |
| `web_search` | — | Runs on Anthropic's servers. Disable with `--no-web`. |

Before a tool that changes something runs, Clay shows you what it is about to do
— the first lines of a write, a before/after for an edit, the command itself —
and waits. `y` runs it once, `a` allows that tool for the rest of the session,
`n` declines and tells Clay so, which it treats as a signal to try something
else rather than to retry.

## Guardrails

- **Workspace sandbox.** Paths are resolved against the workspace root, and
  anything resolving outside it is refused — including via a symlink, which is
  checked with `realpath`. `--allow-outside` lifts this.
- **Approval by default.** Writes, edits and commands ask first. `--yolo` and
  `/yolo` turn that off; with no terminal to ask (piped input, `-p`), they are
  declined unless `--yolo` is set.
- **Command timeouts.** `run_command` is killed after 120s by default, and the
  timeout is reported to Clay rather than hanging the session.
- **Bounded output.** Tool results are capped at 40k characters so one runaway
  file cannot eat the context window.

None of this makes Clay safe to point at a machine you do not trust it with. It
runs shell commands you approve; read them before you approve them.

## Project instructions

If a `CLAY.md` exists at the workspace root, its contents are appended to the
system prompt. Use it for the things you would otherwise repeat every session:

```md
Use tabs, not spaces.
Run `npm run lint` before saying you are done.
The API layer is generated — edit `schema/`, never `src/generated/`.
```

## How it works

`bin/clay.js` parses arguments and owns the terminal. `src/agent.js` runs the
loop: stream a request, hand back every `tool_use` block's result in a single
user message, repeat until Claude stops asking for tools. Along the way it
handles `pause_turn` (server-side tools that need another round trip),
`refusal`, `max_tokens`, and a step cap so a confused model cannot loop forever.
If a turn is interrupted or errors out, the history rewinds to where the turn
started, so a `tool_use` never ends up stranded without its result.

The system prompt and tool definitions are sent as a stable, cached prefix, so
the second and later turns of a session mostly read from cache. `/cost` shows
what that saves.

## Tests

```sh
npm test
```

28 tests covering the tools (including the sandbox and symlink escapes) and the
agent loop, which runs against a stub client — no API key or network needed.

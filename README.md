# Socratic Mentor

A realtime coding mentor that watches what you write and **teaches by asking, not answering.**
It keeps a rolling buffer of the last *N* lines you changed, hands that to Claude, and Claude —
under a strict system prompt — responds with guiding questions and the smallest hints it can,
never the solution. Domain-agnostic: point it at any project you're learning by hand.

## How it works

```
                  first run: scan projectRoot ──▶ Claude summary ──▶ project-context.md
                                                                         │  (cached, reused)
file save ──▶ debounce ──▶ diff vs. last snapshot ──▶ push changed lines │
                                                          │              │
                                              rolling buffer (last N)   goal + context
                                                          │              │
you type ─────────────────────────────────────────────▶ Claude (streamed, context cached)
                                                          │
                                              questions & hints in your terminal
```

- **Diff buffer** — every save is diffed against the previous version; the added/removed lines
  (prefixed `+`/`-`) are appended to a buffer capped at `bufferLines`. That buffer is the mentor's
  window into your recent work.
- **Two-way** — save a file to get feedback, or type in the terminal to answer the mentor / ask it
  something. Both feed one continuous conversation, so it remembers what it already asked.
- **Socratic by construction** — the behavior lives entirely in the system prompt in `mentor.js`.
  Edit that prompt to change how the mentor teaches. It contains no domain assumptions.
- **Your goal, your words** — on first run it asks what you're building and why, and stores your
  answer in `project-goal.md`. Change it anytime with `/goal`.
- **Project context (one-time scan)** — on first run it also scans `projectRoot`, has Claude distill
  it into `project-context.md`, and grounds every turn in your real architecture instead of guessing
  from a bare diff. Cached after the first run; rebuild with `/rescan` (or delete the file).
- **Cheap to keep in context** — the goal + codebase overview ride in the system prompt with
  `cache_control`, so after the first turn Claude reads them back at ~10% of input price. Injecting
  context every turn is effectively free as long as you keep coding (the cache stays warm ~5 min).

## Setup

```sh
cd socratic-mentor
npm install
```

Authenticate — copy `.env.example` to `.env` and paste your key:

```sh
cp .env.example .env      # then edit .env
```

Get a key at <https://platform.claude.com/> → API keys. `.env` is gitignored and loaded
automatically at startup, so you only do this once. (A plain `ANTHROPIC_API_KEY` environment
variable also works if you prefer.)

## Run

```sh
npm start
```

On first run it scans the project, then asks you to describe your goal — type a sentence or two.
After that, open your editor and start writing code in the watched folder.

## Commands (type in the terminal)

| Command                          | Effect                                                                          |
|----------------------------------|---------------------------------------------------------------------------------|
| `/hint [what you're unsure about]` | Next smallest hint — a concept, a function name, or the direction of the bug. Add detail to target it (`/hint why my triangle is black`). Never the fix. |
| `/goal [new goal]`               | With no argument: print your current goal. With text: replace it.               |
| `/whole-file`                    | Toggle context mode. **Off** (default): the mentor sees only the diff on each save. **On**: it also sees the full current file. |
| `/rescan`                        | Re-scan the codebase and rebuild `project-context.md`. Run it after big structural changes. |
| `/help`                          | List commands.                                                                  |
| `/quit`                          | Exit.                                                                            |

Anything that isn't a command is sent to the mentor as your reply.

## Configure — `config.json`

| Key              | Meaning                                                                       |
|------------------|-------------------------------------------------------------------------------|
| `watchPath`      | Folder to watch for your edits (relative to this project).                    |
| `projectRoot`    | Folder scanned once for context. Usually the repo root above `watchPath`.     |
| `memoryFile`     | Where the generated codebase summary is stored (`project-context.md`).        |
| `goalFile`       | Where your described goal is stored (`project-goal.md`).                       |
| `filePatterns`   | Extensions that count as "your code" for diff-watching.                       |
| `scanExtensions` | Extensions included in the one-time context scan.                             |
| `scanIgnore`     | Directories skipped by the scan (`node_modules`, `.git`, …).                   |
| `scanIgnoreFiles`| Individual files skipped by the scan (lockfiles, `.env`).                      |
| `scanMaxBytes`   | Cap on total source read during the scan.                                     |
| `bufferLines`    | **N** — how many recent diff lines the mentor sees.                           |
| `debounceMs`     | Quiet period after a save before the mentor reacts.                           |
| `model`          | Claude model. `claude-sonnet-5` (default) balances quality and cost; `claude-opus-5` is sharpest; `claude-haiku-4-5` is cheapest. |
| `effort`         | `low` for snappy realtime feel; raise to `medium`/`high` for deeper pushback. |
| `maxTokens`      | Response cap. Kept modest so replies stay short and fast.                      |

## Notes

- During a session the mentor sees the **diff**, not whole files (unless you `/whole-file`) — it
  will ask for context when it needs it. That keeps turns cheap and keeps you explaining your own code.
- Nothing here is domain-specific. Point `watchPath`/`projectRoot` at any project and describe your
  goal — the mentor adapts to it.

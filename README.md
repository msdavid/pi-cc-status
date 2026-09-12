# pi-cc-status

A Claude Code–style status line for the [pi coding agent](https://github.com/earendil-works/pi-mono).

Two render modes, selected by config:

- **default** (in-process): theme-integrated segment renderer — model, dir, thinking level, context-window bar + cache %, git, session, cost, tokens, version, providers. Configurable layout, colors, thresholds, and an accessibility mode.
- **command** (Claude-Code-style): spawns a user script, pipes a JSON status object to its stdin, and displays its stdout. **Existing Claude Code statusline scripts work verbatim** — same JSON schema, same contract.

## Install

```bash
# project-local (writes to .pi/settings.json)
pi install -l npm:pi-cc-status

# global (writes to ~/.pi/agent/settings.json)
pi install npm:pi-cc-status
```

Restart pi (or `/reload`) after installing. Pi loads the extension via jiti on next start — no build step.

Try without installing:

```bash
pi -e npm:pi-cc-status
```

## Commands

| Command | Action |
|---|---|
| `/cc-status` | Toggle on/off |
| `/cc-status:reload` | Re-read the config file |
| `/cc-status:edit` | Open the current config in the editor |

## Config

Pi exposes no settings-reading API to extensions, so this package manages its own config file. Resolution is **defaults ← global ← project** (field-by-field merge):

- global: `~/.pi/agent/cc-status/config.json`
- project: `<cwd>/.pi/cc-status/config.json`

Both files are optional. Example with all fields:

```json
{
  "enabled": true,
  "segments": ["model", "dir", "effort", "context", "git"],
  "separator": " | ",
  "bar": { "width": 10, "filled": "█", "empty": "░" },
  "thresholds": { "warning": 80, "error": 95 },
  "refreshSeconds": 2,
  "showCachePercent": true,
  "showModelEndpoint": true,
  "accessibility": {
    "enabled": false,
    "labels": true,
    "plainBar": true
  },
  "command": null,
  "commandRefreshSeconds": null
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off |
| `segments` | `["model","dir","effort","context","git"]` | Ordered segment ids (default mode only) |
| `separator` | `" \| "` | String between segments |
| `bar.width` | `10` | Context-bar cell count |
| `bar.filled` / `bar.empty` | `"█"` / `"░"` | Bar glyphs |
| `thresholds.warning` / `.error` | `80` / `95` | Context % color escalation |
| `refreshSeconds` | `2` | Background git-status poll interval (default mode). `0` disables |
| `showCachePercent` | `true` | Show cache-read % next to the context bar |
| `showModelEndpoint` | `true` | Show the OpenRouter-routed upstream endpoint as a suffix on the model segment (see below) |
| `accessibility.enabled` | `false` | Enable accessible presentation |
| `accessibility.labels` | `true` | Prefix segments with semantic labels (`Model:`, …) |
| `accessibility.plainBar` | `true` | Use `=` / `-` instead of Unicode block glyphs |
| `command` | `null` | Shell command for command mode (see below) |
| `commandRefreshSeconds` | `null` | Periodic re-run interval for command mode. `null` = event-only |

### Default-mode segments

Available ids for the `segments` array:

| Id | Shows |
|---|---|
| `model` | Active model name/id, plus ` @Endpoint` suffix when OpenRouter attribution is known |
| `dir` | Working-directory basename |
| `effort` | Thinking level (`minimal`/`low`/`medium`/`high`/`xhigh`) |
| `context` | Context-window bar gauge + % + cache % |
| `git` | Branch + dirty(`!`)/untracked(`?`) markers |
| `session` | Session name (if set) |
| `cost` | Accumulated session cost (`$X.XXXX`, `+$Y.YYYY sub` when linked child sessions report spend) |
| `duration` | Elapsed wall-clock time since session start (`Hh Mm`/`Mm Ss`/`Ss`) |
| `tokens` | Context tokens / window size |
| `version` | pi version |
| `providers` | Count of available providers |

### Cost accounting (v0.2.0+)

The cost segment and `cost.total_cost_usd` cover the **whole session tree**, using only pi-core mechanisms — no extension is required or special-cased:

1. **Parent session** — assistant messages, plus nested LLM usage reported through pi's standard channel (`usage` on `toolResult` entries, compaction, and branch summaries). This mirrors pi's native `/session` stats, so any tool that reports nested model work (subagents, workflows, summarizers) is counted automatically; extensions that are absent or report nothing simply contribute nothing.
2. **Linked child sessions** — session files whose header carries pi-core's `parentSession` field pointing at the current session (directly or transitively), e.g. sessions created via `/fork`, `/clone`, or `newSession({ parentSession })`. When this contributes, the segment renders as `$0.0123 +$0.0456 sub`.

Scans are cached (2s TTL + per-file mtime/size) and never re-parse unchanged files. Usage that goes through neither channel (e.g. children run with `--no-session`) cannot be observed passively and is not counted.

The command-mode JSON additionally exposes `cost.nested_cost_usd` and `cost.child_session_cost_usd` for scripts that want the split.

### OpenRouter endpoint attribution (v0.3.0+)

When the active model is served by **OpenRouter**, pi only ever sees the provider name `openrouter` — which upstream inference provider (Modal, Novita, …) actually handled each request is invisible to pi. pi-cc-status resolves it dynamically:

1. OpenRouter responses carry an `x-generation-id` header.
2. After each response, the extension looks up `GET openrouter.ai/api/v1/generation?id=<id>` using your OpenRouter credential and reads `data.provider_name`.
3. The model segment renders as e.g. `GLM 5.3 Flash @Modal` (suffix dimmed).

The lookup runs **detached** from the response path: pi awaits `after_provider_response` handlers before finalizing a turn, so awaiting the lookup inline would stall every reply while the 404 retries spin (up to ~25s — OpenRouter writes generation metadata asynchronously, often several seconds after the response). Instead the handler returns immediately and the suffix appears whenever the metadata becomes readable; on failure the previous value stays or the suffix is omitted. The suffix is the endpoint that served the **last completed response** — it can briefly lag a mid-session provider failover. In non-TUI runs (`pi -p`) there is no footer to decorate, so the lookup is skipped entirely. Set `showModelEndpoint: false` to disable. Non-OpenRouter models are unaffected.

## Command mode (Claude Code parity)

Set `command` to a shell command. pi-cc-status gathers all available session data into a JSON object mirroring [Claude Code's statusLine schema](https://code.claude.com/docs/en/statusline) and pipes it to the command's **stdin**; the command's **stdout** is displayed (one line per row).

```json
{
  "command": "~/.claude/statusline.sh",
  "commandRefreshSeconds": 5
}
```

The command can be a script path or an inline one-liner (e.g. a `jq` filter):

```json
{
  "command": "jq -r '\"[\\(.model.display_name)] \\(.context_window.used_percentage // 0)% context\"'"
}
```

Run `/cc-status:reload` after editing the config.

### JSON schema (pi-provided subset)

The object piped to stdin mirrors Claude Code's schema. Fields pi cannot provide are omitted:

```json
{
  "cwd": "/current/working/directory",
  "workspace": { "current_dir": "...", "project_dir": "..." },
  "session_id": "abc123",
  "session_name": "my-session",
  "transcript_path": "/path/to/session.jsonl",
  "model": { "id": "...", "display_name": "..." },
  "version": "0.80.3",
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  },
  "exceeds_200k_tokens": false,
  "effort": { "level": "high" },
  "thinking": { "enabled": true },
  "cost": {
    "total_cost_usd": 0.0123,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 0,
    "total_lines_added": 0,
    "total_lines_removed": 0
  },
  "git": { "branch": "main", "dirty": true, "untracked": false }
}
```

**Not provided by pi** (omitted from the JSON): `workspace.added_dirs`, `workspace.git_worktree`, `workspace.repo`, `rate_limits`, `prompt_id`, `output_style`, `vim.mode`, `agent.name`, `pr.*`, `worktree.*`. `cost.total_api_duration_ms` and `lines_added`/`removed` are not tracked by pi and report `0`.

`current_usage` is `null` before the first API response and after `/compact` until the next response, matching Claude Code.

### Environment

The spawned command receives these env vars (mirroring Claude Code v2.1.153+):

- `COLUMNS` — current terminal width
- `LINES` — current terminal height
- plus the existing process environment

### Refresh triggers (both modes)

The status refreshes on: each assistant message end, after each tool execution, turn end, model change, thinking-level change, session-name change, and git branch change. In command mode, updates are **debounced 300ms** and an in-flight process is cancelled if a newer update fires (matching Claude Code). Set `commandRefreshSeconds` for time-based data while idle.

## Accessibility

Set `accessibility.enabled: true` for an accessible default-mode presentation (inspired by the community [accessibility-first statusline](https://heyclau.de/entry/statuslines/accessibility-first-statusline) pattern):

- **Semantic labels** (`Model:`, `Dir:`, `Context:`, …) for screen-reader context
- **Plain ASCII bar** (`=`/`-`) instead of Unicode block glyphs that screen readers garble
- High-contrast via `theme.bold` emphasis

In command mode, accessibility is the script's responsibility — and **you can reuse the community accessibility-first Claude Code scripts directly**, since the JSON schema matches.

## Requirements

- pi coding agent
- Node.js >= 20

Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`) are provided by pi at runtime as peer dependencies — this package has no runtime dependencies of its own.

## Development

```bash
# Symlink the peer packages (adjust to where pi is installed on your machine):
mkdir -p node_modules/@earendil-works
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core" node_modules/@earendil-works/

node --test test/                          # unit tests
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # typecheck (after: npm i --no-save typescript @types/node)
```

## License

MIT © msdavid

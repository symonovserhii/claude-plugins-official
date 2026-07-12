# telegram-svc — Telegram bot for Claude Code on the Agent SDK

A standalone Bun service that bridges Telegram to Claude Code using
`@anthropic-ai/claude-agent-sdk` (`query()` + in-process MCP tools via
`createSdkMcpServer`). It replaces the previous architecture — the official
`telegram` plugin injecting messages into an interactive `claude` REPL inside
tmux via the experimental `--channels` mechanism — which suffered from
unreliable inbound delivery ([anthropics/claude-code#36477](https://github.com/anthropics/claude-code/issues/36477))
and required terminal-scraping watchdogs to stay alive.

No tmux. No terminal scraping. No experimental channel notifications.
Each inbound message is one bounded `query()` call with a real return value.

## How it works

```
Telegram ──getUpdates──▶ grammy (bot.ts)
                            │  access gate, debounce, voice-in, doc inlining
                            ▼
                     global turn queue (index.ts)
                            │  one turn at a time, shared session
                            ▼
                     query() from Agent SDK (session.ts)
                            │  spawns local `claude` binary, resume=<session>
                            ▼
                in-process MCP tools (tools.ts)
                     reply / react / edit_message / download_attachment
                            │
                            ▼
                        Telegram
```

| Module | Responsibility |
|---|---|
| `index.ts` | entry point, global serialization queue, hadReply watchdog wiring |
| `session.ts` | `query()` orchestration: `<channel>` prompt tag, shared session + resume, 6h in-process session reset, 15-min per-turn timeout, live tool status from stream events |
| `bot.ts` | grammy setup, commands, inbound routing, multi-message debounce buffer |
| `access.ts` | pairing / allowlist / group policy (`access.json`), security gates |
| `tools.ts` | the 4 outbound tools as in-process SDK tools (chunking, long-reply-as-file, inline buttons, voice-out) |
| `permissions.ts` | `canUseTool` → Telegram Allow/Deny inline-button relay |
| `presence.ts` | typing indicator, progress placeholder with elapsed/status ticker |
| `voice.ts` | voice-in (Groq Whisper), voice-out (local TTS container), per-chat voice prefs |
| `digest.ts` | morning digest cron (synthetic inbound at a configured time) |
| `config.ts` | `.env` loading, PID guard (`bot-svc.pid`), crash guards |
| `util.ts` | chunking, document text inlining, skill→bot-command discovery, quick keyboard |

Key properties:

- **Single shared Claude session** across all chats (same semantics as the old
  REPL bot), serialized globally; reset every 6 hours in-process.
- **Subscription auth**: `query()` spawns the locally installed `claude`
  binary and inherits its OAuth login (e.g. a Claude Max subscription).
  `ANTHROPIC_API_KEY` must NOT be set anywhere in the service environment —
  setting it would switch billing to metered API tokens.
- **Precise no-reply watchdog**: the service reads real `tool_use` events from
  the SDK stream; if a turn ends without a `reply`/`edit_message` call, the
  sender gets an immediate warning instead of silence.
- **Model pinned** to `claude-sonnet-5` (override with `TELEGRAM_CLAUDE_MODEL`).
- **Skills and user memory work** inside spawned claude via
  `settingSources: ['user']` — user skills appear as bot commands and the
  quick keyboard can dispatch them.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- Claude Code CLI installed and **authenticated** for the user the service
  runs as (run `claude` once interactively to log in)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Optional: `TELEGRAM_GROQ_KEY` for voice transcription (Groq Whisper),
  a local TTS container for voice replies (see `voice.ts`)

## Installation

```bash
# 1. Clone and install deps
git clone https://github.com/symonovserhii/claude-plugins-official -b deploy/homeserver
cd claude-plugins-official/external_plugins/telegram-svc
bun install

# 2. Bot token (chmod 600 — it's a credential)
mkdir -p ~/.claude/channels/telegram
cat > ~/.claude/channels/telegram/.env <<'EOF'
TELEGRAM_BOT_TOKEN=123456789:AAH...
EOF
chmod 600 ~/.claude/channels/telegram/.env

# 3. Access control — allowlist your own Telegram user id
cat > ~/.claude/channels/telegram/access.json <<'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<your-telegram-user-id>"],
  "groups": {},
  "pending": {}
}
EOF

# 4. Point the claude binary path (only if not the default)
#    session.ts default: /home/ssymonov/.local/share/claude/versions/2.1.207
#    Override via CLAUDE_CLI_PATH in the systemd unit or ~/.claude/channels/telegram/.env

# 5. systemd user unit — EDIT THE PATHS (they are host-specific)
cp claude-telegram-svc.service ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/claude-telegram-svc.service
systemctl --user daemon-reload
systemctl --user enable --now claude-telegram-svc
loginctl enable-linger $USER   # keep the service running without a login session

# 6. Watch it come up
journalctl --user -u claude-telegram-svc -f
# expected: "telegram channel: polling as @<your_bot>"
```

Send your bot a DM — the first turn spawns a fresh claude session and may take
a bit longer than subsequent ones.

## ⚠️ Critical: disable the official telegram plugin

If the `telegram@claude-plugins-official` plugin is enabled, **every claude
spawned by this service boots the plugin's own `server.ts`**, which:

1. reads the legacy `bot.pid` file and SIGTERMs whatever PID it finds there
   (its stale-poller cleanup), and
2. starts a competing `getUpdates` poller against the same bot token.

This service uses its own `bot-svc.pid` precisely so the plugin can't find it,
but the competing poller alone will still steal updates. Before running:

```bash
claude plugin disable telegram@claude-plugins-official
```

If the bot ever starts dying seconds after receiving messages — check
`claude plugin list` first.

Also remember Telegram allows exactly **one** getUpdates consumer per token:
never run this service and the old plugin/wrapper stack at the same time.

## Configuration reference

Environment (real env wins over `~/.claude/channels/telegram/.env`):

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | bot token |
| `TELEGRAM_STATE_DIR` | `~/.claude/channels/telegram` | state root (access.json, inbox, pid) |
| `TELEGRAM_CLAUDE_MODEL` | `claude-sonnet-5` | model for query() |
| `CLAUDE_CLI_PATH` | hardcoded default in `session.ts` | path to the claude binary |
| `TELEGRAM_GROQ_KEY` | — | enables voice transcription (with `access.voice.enabled`) |
| `TELEGRAM_ACCESS_MODE` | — | `static` = snapshot access.json at boot, no runtime mutations |

`access.json` optional keys (see the `Access` type in `access.ts` for the
full contract): `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`,
`progressPlaceholder` (string or per-language map), `voice.enabled`,
`voice.language`, `quickKeyboard.rows`, `morningDigest`, `bufferDelayMs`.

## Operations

- Logs: `journalctl --user -u claude-telegram-svc -f`
- Turn lifecycle log lines: `turn start (model=..., resume=...)`,
  `turn aborted after Xs` (15-min cap), `turn completed without a
  reply/edit_message call` (no-reply watchdog fired)
- Session resets every 6h in-process (`session reset (scheduled)`) — no
  process restart involved
- The service exits non-zero on fatal errors; systemd `Restart=on-failure`
  brings it back

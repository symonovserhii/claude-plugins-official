/**
 * Env loading + single-instance PID guard. Ported from ../telegram/server.ts.
 * No MCP/plugin machinery here anymore — this is a plain long-running Bun
 * process, so the single-instance guard matters even more than before (no
 * plugin host to prevent two copies from ever starting).
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './access.js'

const ENV_FILE = join(STATE_DIR, '.env')

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
try {
  // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN

if (!TOKEN) {
  process.stderr.write(
    `telegram channel: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// Deliberately NOT bot.pid: the legacy plugin's server.ts treats whatever PID
// sits in bot.pid as a "stale poller" and SIGTERMs it. The plugin is disabled
// now, but if it ever gets re-enabled it must not be able to find this
// service's PID (this exact kill chain took the service down twice on
// 2026-07-12, ~1s after each inbound).
export const PID_FILE = join(STATE_DIR, 'bot-svc.pid')

// Telegram allows exactly one getUpdates consumer per token. If a previous
// process crashed (SIGKILL, host reboot without clean shutdown) it can
// survive as an orphan and hold the slot forever, so every new process sees
// 409 Conflict. Kill any stale holder before we start polling.
export function claimSingleInstance(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  try {
    const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (stale > 1 && stale !== process.pid) {
      process.kill(stale, 0)
      process.stderr.write(`telegram channel: replacing stale poller pid=${stale}\n`)
      process.kill(stale, 'SIGTERM')
    }
  } catch {}
  writeFileSync(PID_FILE, String(process.pid))
}

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection.
export function installCrashGuards(): void {
  process.on('unhandledRejection', err => {
    process.stderr.write(`telegram channel: unhandled rejection: ${err}\n`)
  })
  process.on('uncaughtException', err => {
    process.stderr.write(`telegram channel: uncaught exception: ${err}\n`)
  })
}

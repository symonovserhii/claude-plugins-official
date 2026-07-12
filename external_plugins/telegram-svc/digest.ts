/**
 * Morning digest cron. Ported from ../telegram/server.ts's digestTick(),
 * adapted to call an injected onFire callback instead of mcp.notification —
 * index.ts (Phase 4) wires this to enqueue a synthetic inbound message
 * through the same per-chat query() pipeline as a real Telegram message.
 */
import { loadAccess } from './access.js'

export type DigestFireHandler = (chat_id: string, command: string) => void

let lastDigestStamp = ''

export function startDigestCron(onFire: DigestFireHandler): void {
  setInterval(() => digestTick(onFire), 60_000).unref()
}

function digestTick(onFire: DigestFireHandler): void {
  const access = loadAccess()
  const cfg = access.morningDigest
  if (!cfg?.enabled || !cfg.time) return
  const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.time.trim())
  if (!m) return
  const targetH = String(parseInt(m[1], 10)).padStart(2, '0')
  const targetM = m[2]
  const now = new Date()
  const curStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const targetStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${targetH}:${targetM}`
  if (curStamp !== targetStamp || lastDigestStamp === targetStamp) return
  lastDigestStamp = targetStamp
  const chat_id = cfg.chat_id ?? access.allowFrom[0]
  if (!chat_id) return
  const command = cfg.command ?? '/digest'
  try {
    onFire(chat_id, command)
    process.stderr.write(`telegram channel: morning digest fired at ${targetStamp} for chat ${chat_id}\n`)
  } catch (err) {
    process.stderr.write(`telegram channel: morning digest onFire failed: ${err}\n`)
  }
}

/**
 * Typing indicator, progress-placeholder message, and the "did we forget to
 * reply" watchdog. Ported from ../telegram/server.ts with one deliberate
 * change: the original scraped `tmux capture-pane` to (a) show a live
 * "Bash: ..." / "Reading a file" status line in the placeholder and (b)
 * decide whether the watchdog's 5-minute silence was real or Claude was
 * still visibly working. There is no tmux pane anymore — the new
 * architecture drives Claude via query(), which is exactly why this is
 * being rewritten (see plan doc). Both hooks below are injectable and left
 * unset until Phase 4 (session.ts) wires them to real signals from the
 * query() stream:
 *   - liveStatusProvider: called by the progress ticker; Phase 4 should
 *     derive this from the current turn's in-flight tool_use content block
 *     instead of regexing terminal text — a strictly more reliable signal.
 *   - watchdog firing: Phase 4 should replace the blind timer below with
 *     "query() resolved and no reply/edit_message tool call happened this
 *     turn" — known precisely, no timer or liveness guess needed. Until
 *     Phase 4 lands, armWatchdog() is a harmless no-op (see index.ts) rather
 *     than a blind timer that could false-positive on a genuinely long turn.
 */
import type { Bot } from 'grammy'
import type { Access } from './access.js'

// ---- Persistent typing indicator ---------------------------------------
// Telegram clears the typing action after ~5s, so re-ping every 4s while
// we're working.
const typingTickers = new Map<string | number, { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }>()
export function startTyping(bot: Bot, chat_id: string | number) {
  stopTyping(chat_id)
  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  const interval = setInterval(() => {
    void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})
  }, 4000)
  const timeout = setTimeout(() => stopTyping(chat_id), 5 * 60 * 1000)
  typingTickers.set(chat_id, { interval, timeout })
}
export function stopTyping(chat_id: string | number) {
  const t = typingTickers.get(chat_id)
  if (t) {
    clearInterval(t.interval)
    clearTimeout(t.timeout)
    typingTickers.delete(chat_id)
  }
}

// ---- Progress placeholder ------------------------------------------------
// Per-chat placeholder message sent as soon as an inbound arrives, so the
// user sees an immediate visual ack. The first chunk of the next reply
// edits this placeholder in place. Cleared by reply or by timeout.
const DEFAULT_PROGRESS_PLACEHOLDER = '⏳ Thinking...'
const PROGRESS_SEND_TIMEOUT_MS = 3000
const PROGRESS_TIMEOUT_MS = 10 * 60 * 1000
const PROGRESS_TICK_MS = 6000

/** Optional: return a short present-tense status ("Bash: ls -la") for chat_id, or null. Set by index.ts in Phase 4. */
export type LiveStatusProvider = (chat_id: string | number) => string | null
let liveStatusProvider: LiveStatusProvider | null = null
export function setLiveStatusProvider(fn: LiveStatusProvider | null): void {
  liveStatusProvider = fn
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}

type ProgressEntry = {
  message_id: number
  baseText: string
  startedAt: number
  timeout: ReturnType<typeof setTimeout>
  ticker: ReturnType<typeof setInterval>
}
const progressMessages = new Map<string | number, ProgressEntry>()

export function getProgressMessage(chat_id: string | number): { message_id: number } | undefined {
  const e = progressMessages.get(chat_id)
  return e ? { message_id: e.message_id } : undefined
}

export function clearProgress(chat_id: string | number) {
  const e = progressMessages.get(chat_id)
  if (e) {
    clearInterval(e.ticker)
    clearTimeout(e.timeout)
    progressMessages.delete(chat_id)
  }
}

export function pickPlaceholder(setting: string | Record<string, string> | undefined, language_code?: string): string {
  if (typeof setting === 'string') return setting
  if (setting && typeof setting === 'object') {
    if (language_code && setting[language_code]) return setting[language_code]
    if (language_code) {
      const base = language_code.split('-')[0]
      if (setting[base]) return setting[base]
    }
    if (setting.default) return setting.default
    const first = Object.values(setting)[0]
    if (first) return first
  }
  return DEFAULT_PROGRESS_PLACEHOLDER
}

export async function startProgress(bot: Bot, access: Access, chat_id: string | number, language_code?: string): Promise<number | undefined> {
  clearProgress(chat_id)
  try {
    const baseText = pickPlaceholder(access.progressPlaceholder, language_code)
    // Race the API call against a hard timeout so a slow Telegram response
    // never wedges the inbound flow. If the timeout wins, we fall through
    // and Claude still gets the message, just without a placeholder.
    const sent = await Promise.race([
      bot.api.sendMessage(chat_id, baseText),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('progress send timeout')), PROGRESS_SEND_TIMEOUT_MS)),
    ])
    const startedAt = Date.now()
    const timeout = setTimeout(() => clearProgress(chat_id), PROGRESS_TIMEOUT_MS)
    let lastShownText = baseText
    const ticker = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const status = liveStatusProvider?.(chat_id) ?? null
      const display = status
        ? `⏳ ${status}… (${fmtElapsed(elapsed)})`
        : `${baseText} (${fmtElapsed(elapsed)})`
      // Telegram returns 400 'message is not modified' if the text is the
      // same as last edit — skip the API call to keep the rate-limit
      // budget for genuinely new content.
      if (display === lastShownText) return
      lastShownText = display
      void bot.api.editMessageText(chat_id, sent.message_id, display).catch(() => {})
    }, PROGRESS_TICK_MS)
    progressMessages.set(chat_id, { message_id: sent.message_id, baseText, startedAt, timeout, ticker })
    return sent.message_id
  } catch {
    return undefined
  }
}

// ---- "Did we forget to reply" watchdog ----------------------------------
// See file header — this is a stub until Phase 4 wires a precise signal.
// Kept as a named no-op (rather than deleting the call sites) so bot.ts's
// dispatch flow doesn't need to change shape again once Phase 4 lands.
export function armWatchdog(_chat_id: string): void {
  // Intentionally a no-op for now — see file header.
}
export function cancelWatchdog(_chat_id: string): void {
  // Intentionally a no-op for now — see file header.
}

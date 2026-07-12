/**
 * Permission relay: forwards the SDK's canUseTool prompts to Telegram as
 * "Allow / Deny / See more" inline buttons, exactly like the original's
 * notifications/claude/channel/permission_request flow — just wired to the
 * SDK's actual permission-callback API instead of an experimental
 * notification type. bot.ts's `pendingPermissions` map (used for the "See
 * more" expansion) is reused as-is; this module owns the promise side of
 * things (resolving canUseTool once a decision arrives).
 */
import { InlineKeyboard, type Bot } from 'grammy'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { loadAccess } from './access.js'
import { pendingPermissions } from './bot.js'

// 5 lowercase letters a-z minus 'l' — matches PERMISSION_REPLY_RE and the
// `perm:(allow|deny|more):<code>` callback_data regex in bot.ts.
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
function generateRequestId(): string {
  let id = ''
  for (let i = 0; i < 5; i++) id += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  return id
}

// How long to wait for a human to tap Allow/Deny (or reply "yes <code>")
// before defaulting to deny. bypassPermissions means this should rarely
// fire at all, but query() would otherwise hang indefinitely on an
// unanswered prompt if it ever does.
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000

export function createPermissionRelay(bot: Bot) {
  const pendingResolvers = new Map<string, { resolve: (r: PermissionResult) => void; timeout: ReturnType<typeof setTimeout> }>()

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const request_id = generateRequestId()
    const description = options.title ?? options.decisionReason ?? `Use ${toolName}`
    const input_preview = JSON.stringify(input)
    pendingPermissions.set(request_id, { tool_name: toolName, description, input_preview })

    const access = loadAccess()
    const text = `🔐 Permission: ${toolName}`
    const keyboard = new InlineKeyboard()
      .text('See more', `perm:more:${request_id}`)
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    for (const chat_id of access.allowFrom) {
      void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
        process.stderr.write(`telegram-svc: permission_request send to ${chat_id} failed: ${e}\n`)
      })
    }

    return new Promise<PermissionResult>(resolve => {
      const settle = (result: PermissionResult) => {
        clearTimeout(entry.timeout)
        pendingResolvers.delete(request_id)
        pendingPermissions.delete(request_id)
        resolve(result)
      }
      const entry = {
        resolve: settle,
        timeout: setTimeout(() => {
          settle({ behavior: 'deny', message: 'Permission request timed out waiting for a Telegram response.' })
        }, PERMISSION_TIMEOUT_MS),
      }
      pendingResolvers.set(request_id, entry)
      options.signal.addEventListener(
        'abort',
        () => settle({ behavior: 'deny', message: 'Aborted' }),
        { once: true },
      )
    })
  }

  /** Called by bot.ts's onPermissionDecision hook (button tap or "yes <code>" text reply). */
  function resolveDecision(request_id: string, behavior: 'allow' | 'deny'): void {
    const entry = pendingResolvers.get(request_id)
    if (!entry) return // already resolved/timed out, or unknown id — safe no-op
    clearTimeout(entry.timeout)
    pendingResolvers.delete(request_id)
    pendingPermissions.delete(request_id)
    entry.resolve(
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Denied via Telegram' },
    )
  }

  return { canUseTool, resolveDecision }
}

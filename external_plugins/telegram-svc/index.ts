#!/usr/bin/env bun
/**
 * Entry point: wires bot.ts's Telegram-facing hooks to session.ts's
 * query()-driven orchestration, through a single global serialization
 * queue (see session.ts's header on why it's global, not per-chat — one
 * shared Claude Code session across every chat, exactly like the
 * interactive-REPL bot this replaces).
 *
 * permissionMode is 'bypassPermissions' (matches today's
 * --dangerously-skip-permissions), so canUseTool should rarely fire in
 * practice — but it's wired to a real Telegram Allow/Deny relay
 * (permissions.ts) rather than a stub, for the cases where it does.
 */
import { installCrashGuards, claimSingleInstance } from './config.js'
import { createTelegramBot, type BotHooks, type InboundMessage, type ButtonPress } from './bot.js'
import { createTelegramTools } from './tools.js'
import { createPermissionRelay } from './permissions.js'
import { startDigestCron } from './digest.js'
import { runTurn, formatChannelPrompt, formatButtonPressPrompt, startSessionResetTimer, TurnTimeoutError } from './session.js'

installCrashGuards()
claimSingleInstance()

const SESSION_RESET_INTERVAL_MS = 6 * 60 * 60 * 1000 // matches the old systemd-timer cadence

// ---- Global serialization queue ------------------------------------------
// One shared session means one turn in flight at a time, full stop —
// regardless of which chat triggered it. A second inbound arriving mid-turn
// waits its turn instead of racing a concurrent `resume` against the same
// session id.
let queueTail: Promise<void> = Promise.resolve()
function enqueue(task: () => Promise<void>): void {
  queueTail = queueTail.then(task, task)
}

let bot: ReturnType<typeof createTelegramBot>['bot']
let mcpServer: ReturnType<typeof createTelegramTools>
let permissionRelay: ReturnType<typeof createPermissionRelay>

async function processTurn(prompt: string, triggeringChatId: string | undefined): Promise<void> {
  try {
    const result = await runTurn(prompt, mcpServer, permissionRelay.canUseTool)
    if (result.isError) {
      process.stderr.write(`telegram-svc: turn failed (${result.errorSubtype}): ${result.resultText}\n`)
      if (triggeringChatId) {
        await bot.api.sendMessage(
          triggeringChatId,
          `⚠️ Something went wrong processing that (${result.errorSubtype ?? 'error'}). Try again?`,
        ).catch(() => {})
      }
      return
    }
    // Precise replacement for the old blind "5 minutes of silence" watchdog:
    // we know exactly whether reply/edit_message ever fired this turn.
    if (!result.hadReply && triggeringChatId) {
      process.stderr.write('telegram-svc: turn completed without a reply/edit_message call\n')
      await bot.api.sendMessage(
        triggeringChatId,
        '⚠️ No reply was sent for that message. It may have finished using tools but forgot to reply — try repeating the request.',
      ).catch(() => {})
    }
  } catch (err) {
    process.stderr.write(`telegram-svc: runTurn threw: ${err}\n`)
    if (triggeringChatId) {
      const notice = err instanceof TurnTimeoutError
        ? '⚠️ Обработка заняла больше 15 минут и была прервана. Очередь освобождена — попробуй ещё раз или разбей задачу на части.'
        : '⚠️ Internal error processing that message. Try again?'
      await bot.api.sendMessage(triggeringChatId, notice).catch(() => {})
    }
  }
}

const hooks: BotHooks = {
  onInboundMessage: (msg: InboundMessage) => {
    enqueue(() => processTurn(formatChannelPrompt(msg), msg.chat_id))
  },
  onButtonPress: (press: ButtonPress) => {
    enqueue(() => processTurn(formatButtonPressPrompt(press), press.chat_id))
  },
  onPermissionDecision: (request_id, behavior) => {
    permissionRelay.resolveDecision(request_id, behavior)
  },
}

const created = createTelegramBot(hooks)
bot = created.bot
mcpServer = createTelegramTools(bot)
permissionRelay = createPermissionRelay(bot)

startDigestCron((chat_id, command) => {
  hooks.onInboundMessage({
    chat_id,
    text: command,
    ts: new Date().toISOString(),
    user: 'cron',
    user_id: '0',
  })
})

startSessionResetTimer(SESSION_RESET_INTERVAL_MS)

process.on('SIGTERM', created.shutdown)
process.on('SIGINT', created.shutdown)
process.on('SIGHUP', created.shutdown)

await created.start()

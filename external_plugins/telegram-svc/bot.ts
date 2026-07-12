/**
 * Grammy bot setup: commands, inbound message routing, access-control gate,
 * multi-message debounce buffering, permission-reply text intercept, and
 * the button-tap callback handler. Ported from ../telegram/server.ts.
 *
 * This module knows nothing about query()/the SDK — inbound events are
 * handed to the caller via BotHooks instead of an mcp.notification() call.
 * index.ts (Phase 4/5) implements those hooks by driving query().
 */
import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  type GateResult,
  gate,
  dmCommandGate,
  loadAccess,
  startApprovalPoller,
  PERMISSION_REPLY_RE,
  INBOX_DIR,
} from './access.js'
import { TOKEN } from './config.js'
import { buildQuickKeyboard, quickKeyboardCommand, loadSkillCommands, isLikelyTextDoc, extractDocumentText, safeName } from './util.js'
import { transcribeVoice, lastInputWasVoice, getVoiceMode, setVoiceMode } from './voice.js'
import { startTyping, startProgress, armWatchdog } from './presence.js'

// Stores full permission details for "See more" expansion keyed by request_id.
// Populated by index.ts (Phase 5) when it relays a canUseTool prompt.
export const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

export type InboundMessage = {
  chat_id: string
  text: string
  msgId?: number
  ts: string
  user: string
  user_id: string
  language_code?: string
  progress_message_id?: number
  image_path?: string
  buffered_count?: number
  attachment?: AttachmentMeta
}

export type ButtonPress = {
  payload: string
  chat_id?: string
  message_id?: string
  user: string
  user_id: string
}

export interface BotHooks {
  onInboundMessage: (msg: InboundMessage) => void
  onButtonPress: (press: ButtonPress) => void
  onPermissionDecision: (request_id: string, behavior: 'allow' | 'deny') => void
}

export function createTelegramBot(hooks: BotHooks) {
  const bot = new Bot(TOKEN!)
  let botUsername = ''
  let shuttingDown = false

  // ---- Multi-message debounce buffer -------------------------------------
  type BufferedItem = { text: string; msgId?: number; ts: string }
  type ChatBuffer = {
    items: BufferedItem[]
    flushTimer: ReturnType<typeof setTimeout>
    ctx: Context
    from: NonNullable<Context['from']>
  }
  const inboundBuffers = new Map<string, ChatBuffer>()

  startApprovalPoller((chatId, text) => bot.api.sendMessage(chatId, text))

  async function dispatchInbound(opts: {
    ctx: Context
    from: NonNullable<Context['from']>
    chat_id: string
    text: string
    msgId?: number
    ts: string
    attachment?: AttachmentMeta
    imagePath?: string
    bufferedCount?: number
  }): Promise<void> {
    const access = loadAccess()
    // Post the placeholder before handing off to the caller so by the time
    // Claude starts working there is already a visible message in the chat.
    const progressMessageId = await startProgress(bot, access, opts.chat_id, opts.from.language_code)
    armWatchdog(opts.chat_id)

    hooks.onInboundMessage({
      chat_id: opts.chat_id,
      text: opts.text,
      msgId: opts.msgId,
      ts: opts.ts,
      progress_message_id: progressMessageId,
      user: opts.from.username ?? String(opts.from.id),
      user_id: String(opts.from.id),
      language_code: opts.from.language_code,
      ...(opts.imagePath ? { image_path: opts.imagePath } : {}),
      ...(opts.bufferedCount && opts.bufferedCount > 1 ? { buffered_count: opts.bufferedCount } : {}),
      ...(opts.attachment ? { attachment: opts.attachment } : {}),
    })
  }

  async function flushInboundBuffer(chat_id: string): Promise<void> {
    const buf = inboundBuffers.get(chat_id)
    if (!buf) return
    inboundBuffers.delete(chat_id)
    clearTimeout(buf.flushTimer)
    const combined = buf.items.map(i => i.text).join('\n\n')
    const last = buf.items[buf.items.length - 1]
    await dispatchInbound({
      ctx: buf.ctx,
      from: buf.from,
      chat_id,
      text: combined,
      msgId: last.msgId,
      ts: last.ts,
      bufferedCount: buf.items.length,
    })
  }

  async function handleInbound(
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ): Promise<void> {
    const result: GateResult = gate(ctx, botUsername)

    if (result.action === 'drop') return

    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
      return
    }

    const access = result.access
    const from = ctx.from!
    const chat_id = String(ctx.chat!.id)
    const msgId = ctx.message?.message_id

    // Permission-reply intercept: if this looks like "yes xxxxx" for a
    // pending permission request, emit the decision instead of relaying as
    // chat. The sender is already gate()-approved at this point. MUST run
    // on the raw, unmodified text before any rewriting below.
    const permMatch = PERMISSION_REPLY_RE.exec(text)
    if (permMatch) {
      hooks.onPermissionDecision(
        permMatch[2]!.toLowerCase(),
        permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      )
      if (msgId != null) {
        const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
        void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]).catch(() => {})
      }
      return
    }

    // Quick-keyboard label → command rewrite.
    const mappedCommand = quickKeyboardCommand(access, text)
    if (mappedCommand) text = mappedCommand

    // Enrich text with reply/forward context.
    const replyToMsg = ctx.message?.reply_to_message
    if (replyToMsg) {
      const orig = (replyToMsg as { text?: string; caption?: string }).text
        ?? (replyToMsg as { text?: string; caption?: string }).caption
        ?? '(non-text)'
      const excerpt = orig.length > 240 ? orig.slice(0, 240) + '…' : orig
      text = `[↩ replying to: "${excerpt}"]\n${text}`
    }
    const fwd = (ctx.message as { forward_origin?: { type: string; sender_user?: { username?: string; first_name?: string }; sender_chat?: { title?: string }; chat?: { title?: string }; sender_user_name?: string; date?: number } }).forward_origin
    if (fwd) {
      let source = 'unknown'
      if (fwd.type === 'user' && fwd.sender_user) source = fwd.sender_user.username ? `@${fwd.sender_user.username}` : (fwd.sender_user.first_name ?? 'user')
      else if (fwd.type === 'chat' && fwd.sender_chat) source = fwd.sender_chat.title ?? 'chat'
      else if (fwd.type === 'channel' && fwd.chat) source = fwd.chat.title ?? 'channel'
      else if (fwd.type === 'hidden_user' && fwd.sender_user_name) source = fwd.sender_user_name
      const when = fwd.date ? new Date(fwd.date * 1000).toISOString() : ''
      text = `[↪ forwarded from ${source}${when ? ` at ${when}` : ''}]\n${text}`
    }

    startTyping(bot, chat_id)

    if (access.ackReaction && msgId != null) {
      void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] }]).catch(() => {})
    }

    const imagePath = downloadImage ? await downloadImage() : undefined

    // Multi-message debounce: plain text with no attachment/image queues and
    // resets the flush timer; the flush coalesces queued messages into one
    // dispatch. Attachment/image bypasses buffering but flushes any pending
    // text first so order is preserved.
    const bufferDelay = access.bufferDelayMs ?? 0
    const ts = new Date((ctx.message?.date ?? 0) * 1000).toISOString()
    if (bufferDelay > 0 && !attachment && !imagePath) {
      let buf = inboundBuffers.get(chat_id)
      if (buf) {
        clearTimeout(buf.flushTimer)
        buf.items.push({ text, msgId, ts })
      } else {
        buf = { items: [{ text, msgId, ts }], flushTimer: setTimeout(() => {}, 0), ctx, from }
        clearTimeout(buf.flushTimer)
        inboundBuffers.set(chat_id, buf)
      }
      buf.flushTimer = setTimeout(() => {
        void flushInboundBuffer(chat_id)
      }, bufferDelay)
      return
    }
    if (inboundBuffers.has(chat_id)) {
      await flushInboundBuffer(chat_id)
    }
    await dispatchInbound({ ctx, from, chat_id, text, msgId, ts, attachment, imagePath })
  }

  // ---- Commands (DM-only — see original rationale on group silence) ------
  bot.command('start', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const keyboard = buildQuickKeyboard(gated.access)
    await ctx.reply(
      `This bot bridges Telegram to a Claude Code session.\n\n` +
      `To pair:\n` +
      `1. DM me anything — you'll get a 6-char code\n` +
      `2. In Claude Code: /telegram:access pair <code>\n\n` +
      `After that, DMs here reach that session.`,
      keyboard ? { reply_markup: keyboard } : undefined,
    )
  })

  bot.command('help', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const keyboard = buildQuickKeyboard(gated.access)
    await ctx.reply(
      `Messages you send here route to a paired Claude Code session. ` +
      `Text and photos are forwarded; replies and reactions come back.\n\n` +
      `/start — pairing instructions\n` +
      `/status — check your pairing state\n` +
      `/kb — show the quick-action keyboard (if configured)\n` +
      `/voice — control whether replies come back as voice messages`,
      keyboard ? { reply_markup: keyboard } : undefined,
    )
  })

  bot.command('kb', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const keyboard = buildQuickKeyboard(gated.access)
    if (!keyboard) {
      await ctx.reply('No quick keyboard configured. Set access.quickKeyboard.rows in access.json.')
      return
    }
    await ctx.reply('Quick actions:', { reply_markup: keyboard })
  })

  bot.command('voice', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const chat_id = String(ctx.chat.id)
    const arg = (ctx.match || '').trim().toLowerCase()

    if (!arg) {
      const current = getVoiceMode(chat_id)
      await ctx.reply(
        `Current mode: ${current}\n\n` +
        `Modes:\n` +
        `• auto — voice reply to voice input, text reply to text input (default)\n` +
        `• on — always reply with voice\n` +
        `• off — always reply with text\n\n` +
        `Usage: /voice auto | /voice on | /voice off`
      )
      return
    }

    if (arg !== 'auto' && arg !== 'on' && arg !== 'off') {
      await ctx.reply(`Unknown mode "${arg}". Use auto, on, or off.`)
      return
    }

    setVoiceMode(chat_id, arg as 'auto' | 'on' | 'off')
    const labels: Record<string, string> = {
      auto: 'Auto — mirrors your input',
      on: 'Always reply with voice',
      off: 'Always reply with text',
    }
    await ctx.reply(labels[arg])
  })

  bot.command('status', async ctx => {
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const { access, senderId } = gated

    if (access.allowFrom.includes(senderId)) {
      const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
      await ctx.reply(`Paired as ${name}.`)
      return
    }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        await ctx.reply(`Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`)
        return
      }
    }

    await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
  })

  // ---- Inline-button handler for permission requests + user buttons ------
  bot.on('callback_query:data', async ctx => {
    const data = ctx.callbackQuery.data

    if (data.startsWith('usr:')) {
      const access = loadAccess()
      const senderId = String(ctx.from.id)
      if (!access.allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const payload = data.slice(4)
      const chatId = ctx.callbackQuery.message?.chat.id
      const msgId = ctx.callbackQuery.message?.message_id
      hooks.onButtonPress({
        payload,
        ...(chatId != null ? { chat_id: String(chatId) } : {}),
        ...(msgId != null ? { message_id: String(msgId) } : {}),
        user: ctx.from.username ?? String(ctx.from.id),
        user_id: senderId,
      })
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
    if (!m) {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, behavior, request_id] = m

    if (behavior === 'more') {
      const details = pendingPermissions.get(request_id)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
      await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    hooks.onPermissionDecision(request_id, behavior as 'allow' | 'deny')
    pendingPermissions.delete(request_id)
    const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })

  // ---- Inbound message routing --------------------------------------------
  bot.on('message:text', async ctx => {
    lastInputWasVoice.set(String(ctx.chat.id), false)
    await handleInbound(ctx, ctx.message.text, undefined)
  })

  bot.on('message:photo', async ctx => {
    const caption = ctx.message.caption ?? '(photo)'
    await handleInbound(ctx, caption, async () => {
      const photos = ctx.message.photo
      const best = photos[photos.length - 1]
      try {
        const file = await ctx.api.getFile(best.file_id)
        if (!file.file_path) return undefined
        const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
        const res = await fetch(url)
        const buf = Buffer.from(await res.arrayBuffer())
        const ext = file.file_path.split('.').pop() ?? 'jpg'
        const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
        mkdirSync(INBOX_DIR, { recursive: true })
        writeFileSync(path, buf)
        return path
      } catch (err) {
        process.stderr.write(`telegram channel: photo download failed: ${err}\n`)
        return undefined
      }
    })
  })

  bot.on('message:document', async ctx => {
    const doc = ctx.message.document
    const name = safeName(doc.file_name)
    const caption = ctx.message.caption ?? ''
    let text = caption || `(document: ${name ?? 'file'})`
    if (isLikelyTextDoc(doc.mime_type, name, doc.file_size)) {
      const extracted = await extractDocumentText(bot, doc.file_id)
      if (extracted) {
        const fence = '```'
        const captionLine = caption ? caption + '\n\n' : ''
        text = `${captionLine}${fence} ${name ?? 'document'}\n${extracted}\n${fence}`
      }
    }
    await handleInbound(ctx, text, undefined, {
      kind: 'document',
      file_id: doc.file_id,
      size: doc.file_size,
      mime: doc.mime_type,
      name,
    })
  })

  bot.on('message:voice', async ctx => {
    lastInputWasVoice.set(String(ctx.chat.id), true)
    const voice = ctx.message.voice
    const access = loadAccess()
    let text = ctx.message.caption ?? '(voice message)'
    if (access.voice?.enabled) {
      const transcript = await transcribeVoice(bot, voice.file_id, access.voice.language)
      if (transcript) text = `🎤 ${transcript}`
    }
    await handleInbound(ctx, text, undefined, {
      kind: 'voice',
      file_id: voice.file_id,
      size: voice.file_size,
      mime: voice.mime_type,
    })
  })

  bot.on('message:audio', async ctx => {
    const audio = ctx.message.audio
    const name = safeName(audio.file_name)
    const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
    await handleInbound(ctx, text, undefined, {
      kind: 'audio',
      file_id: audio.file_id,
      size: audio.file_size,
      mime: audio.mime_type,
      name,
    })
  })

  bot.on('message:video', async ctx => {
    const video = ctx.message.video
    const text = ctx.message.caption ?? '(video)'
    await handleInbound(ctx, text, undefined, {
      kind: 'video',
      file_id: video.file_id,
      size: video.file_size,
      mime: video.mime_type,
      name: safeName(video.file_name),
    })
  })

  bot.on('message:video_note', async ctx => {
    const vn = ctx.message.video_note
    await handleInbound(ctx, '(video note)', undefined, {
      kind: 'video_note',
      file_id: vn.file_id,
      size: vn.file_size,
    })
  })

  bot.on('message:sticker', async ctx => {
    const sticker = ctx.message.sticker
    const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
    await handleInbound(ctx, `(sticker${emoji})`, undefined, {
      kind: 'sticker',
      file_id: sticker.file_id,
      size: sticker.file_size,
    })
  })

  // Without this, any throw in a message handler stops polling permanently
  // (grammy's default error handler calls bot.stop() and rethrows).
  bot.catch(err => {
    process.stderr.write(`telegram channel: handler error (polling continues): ${err.error}\n`)
  })

  async function start(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start({
          onStart: info => {
            attempt = 0
            botUsername = info.username
            process.stderr.write(`telegram channel: polling as @${info.username}\n`)
            const skillCommands = loadSkillCommands()
            const allCommands = [
              { command: 'start', description: 'Welcome and setup guide' },
              { command: 'help', description: 'What this bot can do' },
              { command: 'status', description: 'Check your pairing status' },
              { command: 'kb', description: 'Show the quick-action keyboard' },
              { command: 'voice', description: 'Set voice reply mode (auto/on/off)' },
              ...skillCommands,
            ].slice(0, 100)
            void bot.api.setMyCommands(allCommands, { scope: { type: 'all_private_chats' } }).catch(() => {})
            if (skillCommands.length > 0) {
              process.stderr.write(`telegram channel: registered ${skillCommands.length} skill commands in bot menu\n`)
            }
          },
        })
        return // bot.stop() was called — clean exit from the loop
      } catch (err) {
        if (shuttingDown) return
        if (err instanceof Error && err.message === 'Aborted delay') return
        const is409 = err instanceof GrammyError && err.error_code === 409
        if (is409 && attempt >= 8) {
          process.stderr.write(
            `telegram channel: 409 Conflict persists after ${attempt} attempts — ` +
            `another poller is holding the bot token (stray process or a second instance). Exiting.\n`,
          )
          return
        }
        const delay = Math.min(1000 * attempt, 15000)
        const detail = is409
          ? `409 Conflict${attempt === 1 ? ' — another instance is polling' : ''}`
          : `polling error: ${err}`
        process.stderr.write(`telegram channel: ${detail}, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    process.stderr.write('telegram channel: shutting down\n')
    void Promise.resolve(bot.stop()).finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  }

  return { bot, start, shutdown }
}

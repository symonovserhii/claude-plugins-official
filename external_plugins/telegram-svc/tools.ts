/**
 * The 4 Telegram tools (reply, react, edit_message, download_attachment) as
 * in-process SDK tools via tool()/createSdkMcpServer() instead of a stdio
 * MCP server. Handler bodies ported near-verbatim from ../telegram/server.ts
 * — the actual Telegram-sending code doesn't change, only how the tool gets
 * wired to the model (no MCP transport, called directly in-process).
 */
import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { InputFile, type Bot } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import { writeFileSync, rmSync, statSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import { assertAllowedChat, loadAccess, INBOX_DIR } from './access.js'
import { assertSendable, chunk, PHOTO_EXTS, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES } from './util.js'
import { synthesizeVoice, shouldRespondWithVoice } from './voice.js'
import { stopTyping, cancelWatchdog, getProgressMessage, clearProgress } from './presence.js'
import { TOKEN } from './config.js'

const ButtonSchema = z.object({ text: z.string(), payload: z.string() })

const ReplyInput = {
  chat_id: z.string(),
  text: z.string(),
  reply_to: z.string().optional().describe('Message ID to thread under. Use message_id from the inbound <channel> block.'),
  files: z.array(z.string()).optional().describe('Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.'),
  format: z.enum(['text', 'markdownv2']).optional().describe("Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text'."),
  buttons: z.array(z.array(ButtonSchema)).optional().describe('Optional inline buttons attached to the last message sent. 2D array — outer = rows, inner = buttons in that row. When the sender taps a button you receive a regular channel notification with meta.event="button_press" and meta.payload set to the button payload.'),
}

const ReactInput = {
  chat_id: z.string(),
  message_id: z.string(),
  emoji: z.string(),
}

const DownloadAttachmentInput = {
  file_id: z.string().describe('The attachment_file_id from inbound meta'),
}

const EditMessageInput = {
  chat_id: z.string(),
  message_id: z.string(),
  text: z.string(),
  format: z.enum(['text', 'markdownv2']).optional().describe("Rendering mode. 'markdownv2' enables Telegram formatting. Default: 'text'."),
}

export function createTelegramTools(bot: Bot) {
  const replyTool = tool(
    'reply',
    'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
    ReplyInput,
    async args => {
      const chat_id = args.chat_id
      let text = args.text
      const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
      const files = args.files ?? []
      const format = args.format ?? 'text'
      const parseMode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined

      assertAllowedChat(chat_id)

      // Long-reply-as-file: when the response is much bigger than a few
      // Telegram messages, attach the full text as a .md file instead of
      // spamming the chat with chunks.
      const LONG_REPLY_AS_FILE_THRESHOLD = 12000
      let longReplyTmpPath: string | undefined
      if (text.length >= LONG_REPLY_AS_FILE_THRESHOLD && files.length === 0) {
        const tmp = join(tmpdir(), `tg-reply-${Date.now()}-${randomBytes(4).toString('hex')}.md`)
        writeFileSync(tmp, text, { mode: 0o600 })
        files.push(tmp)
        longReplyTmpPath = tmp
        const preview = text.slice(0, 600).replace(/\s+$/, '')
        text = `${preview}\n\n…(${text.length.toLocaleString()} chars total — full reply attached)`
      }

      for (const f of files) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
        }
      }

      // Voice output: if user prefers voice and no files attached, synthesize
      // and send as voice message instead of text chunks.
      if (files.length === 0 && text.length < 4000 && shouldRespondWithVoice(chat_id)) {
        const audio = await synthesizeVoice(text)
        if (audio && audio.length > 0) {
          stopTyping(chat_id)
          cancelWatchdog(chat_id)
          const progress = getProgressMessage(chat_id)
          if (progress) {
            void bot.api.deleteMessage(chat_id, progress.message_id).catch(() => {})
            clearProgress(chat_id)
          }
          const tmpOgg = join(tmpdir(), `tg-voice-${Date.now()}-${randomBytes(4).toString('hex')}.ogg`)
          writeFileSync(tmpOgg, audio, { mode: 0o600 })
          try {
            const sent = await bot.api.sendVoice(chat_id, new InputFile(tmpOgg), {
              ...(reply_to ? { reply_parameters: { message_id: reply_to } } : {}),
            })
            return { content: [{ type: 'text', text: `sent (id: ${sent.message_id}, voice)` }] }
          } finally {
            try { rmSync(tmpOgg) } catch {}
          }
        }
        // TTS failed — fall through to text path
      }

      const access = loadAccess()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(text, limit, mode)
      const sentIds: number[] = []
      stopTyping(chat_id)
      cancelWatchdog(chat_id)

      // If we sent a placeholder on inbound, edit it with the first chunk
      // instead of sending a new message.
      const progress = getProgressMessage(chat_id)
      let editedPlaceholder = false
      if (progress && chunks.length > 0) {
        if (files.length === 0) {
          try {
            await bot.api.editMessageText(chat_id, progress.message_id, chunks[0], {
              ...(parseMode ? { parse_mode: parseMode } : {}),
            })
            sentIds.push(progress.message_id)
            editedPlaceholder = true
          } catch {
            // identical text or other edit failure — fall through to normal send
          }
        } else {
          void bot.api.deleteMessage(chat_id, progress.message_id).catch(() => {})
        }
        clearProgress(chat_id)
      }

      // Inline buttons attached to the last message of the reply.
      const buttons = args.buttons ?? []
      let buttonMarkup: import('grammy').InlineKeyboard | undefined
      if (buttons.length > 0) {
        const { InlineKeyboard } = await import('grammy')
        buttonMarkup = new InlineKeyboard()
        for (let r = 0; r < buttons.length; r++) {
          for (const b of buttons[r]) {
            buttonMarkup.text(b.text, `usr:${b.payload}`.slice(0, 64))
          }
          if (r < buttons.length - 1) buttonMarkup.row()
        }
      }
      const lastIsFile = files.length > 0
      const lastTextChunk = chunks.length - 1

      try {
        for (let i = editedPlaceholder ? 1 : 0; i < chunks.length; i++) {
          const shouldReplyTo =
            reply_to != null &&
            replyMode !== 'off' &&
            (replyMode === 'all' || i === 0)
          const attachButtons = !lastIsFile && i === lastTextChunk && buttonMarkup
          const sent = await bot.api.sendMessage(chat_id, chunks[i], {
            ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
            ...(attachButtons ? { reply_markup: buttonMarkup } : {}),
          })
          sentIds.push(sent.message_id)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
      }

      // Files go as separate messages. Thread under reply_to if present.
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi]
        const ext = extname(f).toLowerCase()
        const input = new InputFile(f)
        const isLast = fi === files.length - 1
        const opts = {
          ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
          ...(isLast && buttonMarkup ? { reply_markup: buttonMarkup } : {}),
        }
        if (PHOTO_EXTS.has(ext)) {
          const sent = await bot.api.sendPhoto(chat_id, input, opts)
          sentIds.push(sent.message_id)
        } else {
          const sent = await bot.api.sendDocument(chat_id, input, opts)
          sentIds.push(sent.message_id)
        }
      }

      if (longReplyTmpPath) {
        try { rmSync(longReplyTmpPath) } catch {}
      }
      const result =
        sentIds.length === 1
          ? `sent (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
      return { content: [{ type: 'text', text: result }] }
    },
  )

  const reactTool = tool(
    'react',
    'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    ReactInput,
    async args => {
      assertAllowedChat(args.chat_id)
      await bot.api.setMessageReaction(args.chat_id, Number(args.message_id), [
        { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
      ])
      return { content: [{ type: 'text', text: 'reacted' }] }
    },
  )

  const downloadAttachmentTool = tool(
    'download_attachment',
    'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    DownloadAttachmentInput,
    async args => {
      const file = await bot.api.getFile(args.file_id)
      if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // file_path is from Telegram (trusted), but strip to safe chars anyway
      // so nothing downstream can be tricked by an unexpected extension.
      const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
      const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return { content: [{ type: 'text', text: path }] }
    },
  )

  const editMessageTool = tool(
    'edit_message',
    "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    EditMessageInput,
    async args => {
      assertAllowedChat(args.chat_id)
      const editChatId = args.chat_id
      const editMsgId = Number(args.message_id)
      // Claude is actively producing output — stop the typing indicator and
      // cancel the unanswered-inbound watchdog. If Claude is editing OUR
      // progress placeholder, also kill the elapsed-time ticker.
      stopTyping(editChatId)
      cancelWatchdog(editChatId)
      const progress = getProgressMessage(editChatId)
      if (progress && progress.message_id === editMsgId) {
        clearProgress(editChatId)
      }
      const editFormat = args.format ?? 'text'
      const editParseMode = editFormat === 'markdownv2' ? ('MarkdownV2' as const) : undefined
      const edited = await bot.api.editMessageText(
        editChatId,
        editMsgId,
        args.text,
        ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
      )
      const id = typeof edited === 'object' ? edited.message_id : args.message_id
      return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
    },
  )

  return createSdkMcpServer({
    name: 'telegram',
    version: '1.0.0',
    tools: [replyTool, reactTool, downloadAttachmentTool, editMessageTool],
  })
}

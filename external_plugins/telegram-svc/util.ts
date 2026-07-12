/**
 * Pure formatting/security helpers shared between the inbound bot handlers
 * and the outbound tools. Ported unchanged from ../telegram/server.ts.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { extname, join, sep } from 'path'
import type { Bot } from 'grammy'
import { STATE_DIR, type Access } from './access.js'
import { TOKEN } from './config.js'

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

// reply's files param takes any path. .env is ~60 bytes and ships as a
// document. Claude can already Read+paste file contents, so this isn't a new
// exfil channel for arbitrary paths — but the server's own state is the one
// thing Claude has no reason to ever send.
export function assertSendable(f: string): void {
  let real, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return } // statSync will fail properly; or STATE_DIR absent → nothing to leak
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// Telegram caps messages at 4096 chars. Split long replies, preferring
// paragraph boundaries when chunkMode is 'newline'.
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
export const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Filenames and titles are uploader-controlled. They land inside the prompt
// sent to query() — delimiter chars would let the uploader break out of the
// <channel> tag or forge a second meta entry.
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>[\]\r\n;]/g, '_')
}

// ---- Inline-extract text from document attachments ----------------------
// Text-y documents the user sends as attachments — code files, config, csv,
// json, markdown — get their body pulled straight into the inbound
// prompt instead of making Claude call download_attachment first.
// Capped at DOC_INLINE_MAX_BYTES to keep prompt size reasonable. Binary
// formats (pdf, docx, etc.) are not handled here — Claude can still call
// download_attachment for them.
export const DOC_INLINE_MAX_BYTES = 256 * 1024
const TEXT_DOC_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonc', '.xml', '.yaml',
  '.yml', '.toml', '.ini', '.conf', '.cfg', '.env', '.log', '.html', '.htm',
  '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.sh', '.bash', '.zsh',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cc', '.sql', '.diff', '.patch',
])
export function isLikelyTextDoc(mime: string | undefined, name: string | undefined, size: number | undefined): boolean {
  if (size != null && size > DOC_INLINE_MAX_BYTES) return false
  if (mime) {
    const m = mime.split(';')[0].trim().toLowerCase()
    if (m.startsWith('text/')) return true
    if (m === 'application/json' || m === 'application/xml' || m === 'application/yaml' || m === 'application/x-yaml' || m === 'application/javascript' || m === 'application/typescript' || m === 'application/x-sh') return true
  }
  if (name) {
    const ext = extname(name).toLowerCase()
    if (TEXT_DOC_EXTS.has(ext)) return true
  }
  return false
}
export async function extractDocumentText(bot: Bot, file_id: string): Promise<string | null> {
  try {
    const file = await bot.api.getFile(file_id)
    if (!file.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > DOC_INLINE_MAX_BYTES) return null
    // Reject likely-binary content (NUL bytes in first 4KB) — the file might
    // have a misleading text-ish extension but actually be binary.
    const sample = buf.subarray(0, 4096)
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

// ---- Auto-register user skills as bot commands -------------------------
// Discover user skills from ~/.claude/skills/<name>/SKILL.md and register
// them as Telegram bot commands so they show up under the "/" menu in
// chat. Telegram requires command names to match [a-z][a-z0-9_]{0,31};
// skills with hyphens (e.g. ai-factory) are skipped — invoke those by
// typing the slash manually. Description is taken from the YAML
// frontmatter and truncated to 256 chars (Telegram's max).
export function loadSkillCommands(): { command: string; description: string }[] {
  const skillsDir = join(homedir(), '.claude', 'skills')
  let entries: string[] = []
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return []
  }
  const out: { command: string; description: string }[] = []
  for (const name of entries.sort()) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) continue
    let content: string
    try {
      content = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(content)
    if (!fmMatch) continue
    const fm = fmMatch[1]
    const dInline = /^description:\s*(.+)$/m.exec(fm)
    let desc = dInline ? dInline[1].trim() : ''
    if (desc === '|' || desc === '>' || desc === '|-' || desc === '>-') {
      const dBlock = /^description:\s*[|>]-?\s*\n((?:  .*\n?)+)/m.exec(fm)
      if (dBlock) desc = dBlock[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ')
    }
    if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
      desc = desc.slice(1, -1)
    }
    if (desc.length > 256) desc = desc.slice(0, 253) + '...'
    if (desc.length < 3) continue
    out.push({ command: name, description: desc })
  }
  return out
}

// ---- Quick-keyboard helpers --------------------------------------------
// Turn access.quickKeyboard config into a Telegram ReplyKeyboardMarkup, and
// translate a tapped label back to its configured command so inbound
// dispatch can proceed as if the user typed it.
export function buildQuickKeyboard(access: Access): { keyboard: { text: string }[][]; resize_keyboard: boolean; is_persistent: boolean } | undefined {
  const rows = access.quickKeyboard?.rows
  if (!rows || rows.length === 0) return undefined
  return {
    keyboard: rows.map(row => row.map(b => ({ text: b.label }))),
    resize_keyboard: true,
    is_persistent: true,
  }
}
export function quickKeyboardCommand(access: Access, text: string): string | null {
  const rows = access.quickKeyboard?.rows
  if (!rows) return null
  for (const row of rows) {
    for (const btn of row) {
      if (btn.label === text) return btn.command
    }
  }
  return null
}

export function statSyncSize(path: string): number {
  return statSync(path).size
}

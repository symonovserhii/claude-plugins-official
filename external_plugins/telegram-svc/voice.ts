/**
 * Voice in (Groq Whisper transcription) and voice out (local TTS container).
 * Ported unchanged from ../telegram/server.ts.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Bot } from 'grammy'
import { STATE_DIR } from './access.js'
import { TOKEN } from './config.js'

const execFileAsync = promisify(execFile)

// ---- Voice transcription via Groq Whisper --------------------------------
// Off-default; opt-in through access.voice.enabled. Bounded by a 30s timeout
// so a slow API can't wedge the inbound flow — falls back to passing the raw
// attachment through.
const GROQ_KEY = process.env.TELEGRAM_GROQ_KEY
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const TRANSCRIBE_TIMEOUT_MS = 30000
export async function transcribeVoice(bot: Bot, file_id: string, language?: string): Promise<string | null> {
  if (!GROQ_KEY) return null
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS)
  try {
    const file = await bot.api.getFile(file_id)
    if (!file.file_path) return null
    const dlRes = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, { signal: ac.signal })
    if (!dlRes.ok) return null
    const buf = Buffer.from(await dlRes.arrayBuffer())
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: 'audio/ogg' }), 'audio.ogg')
    fd.append('model', 'whisper-large-v3')
    if (language && language !== 'auto') fd.append('language', language)
    fd.append('response_format', 'text')
    const res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: fd,
      signal: ac.signal,
    })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    return text || null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// ---- Voice output (TTS) -----------------------------------------------
// Synthesizes a voice reply via a local `gemini-code-bot` Docker container's
// TTS CLI. Environment-specific (assumes that container exists on the
// host) — ported as-is since it's opt-in per chat via /voice and silently
// falls back to text if the container/exec fails.
const VOICE_PREFS_FILE = join(STATE_DIR, 'voice_prefs.json')
export type VoiceMode = 'auto' | 'on' | 'off'

function loadVoicePrefs(): Record<string, VoiceMode> {
  try {
    return JSON.parse(readFileSync(VOICE_PREFS_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function saveVoicePrefs(prefs: Record<string, VoiceMode>) {
  writeFileSync(VOICE_PREFS_FILE, JSON.stringify(prefs, null, 2))
}
export function getVoiceMode(chat_id: string | number): VoiceMode {
  const prefs = loadVoicePrefs()
  return prefs[String(chat_id)] ?? 'auto'
}
export function setVoiceMode(chat_id: string | number, mode: VoiceMode) {
  const prefs = loadVoicePrefs()
  prefs[String(chat_id)] = mode
  saveVoicePrefs(prefs)
}

// Track if user's last inbound was voice (for auto mode).
export const lastInputWasVoice = new Map<string, boolean>()

// Strip markdown — TTS reads asterisks/backticks literally.
function stripMarkdown(text: string): string {
  return text
    .replace(/[*_`~#]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

// Call gemini-code-bot's Python TTS CLI, returns OGG Opus bytes or null on error.
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  const clean = stripMarkdown(text).slice(0, 1500)
  if (!clean.trim()) return null
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['exec', 'gemini-code-bot', 'python3', '-m', 'bot_core.tts_cli', clean],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
    )
    return stdout as Buffer
  } catch (e) {
    process.stderr.write(`telegram channel: tts failed: ${(e as Error).message}\n`)
    return null
  }
}

export function shouldRespondWithVoice(chat_id: string): boolean {
  const mode = getVoiceMode(chat_id)
  if (mode === 'on') return true
  if (mode === 'off') return false
  // auto: mirror input
  return lastInputWasVoice.get(chat_id) ?? false
}

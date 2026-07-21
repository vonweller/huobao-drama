/**
 * AI 音色管理
 * GET  /api/v1/ai-voices       - 获取音色列表
 * POST /api/v1/ai-voices/sync  - 从 MiniMax 同步音色
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

const app = new Hono()

// GET /ai-voices?provider=minimax
app.get('/', async (c) => {
  const provider = c.req.query('provider') || 'minimax'
  const rows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider))
    .all()

  const parsed = rows.map(r => ({
    voice_id: r.voiceId,
    voice_name: r.voiceName,
    description: r.description ? JSON.parse(r.description) : [],
    language: r.language,
    provider: r.provider,
  }))

  return success(c, parsed)
})

// POST /ai-voices/sync?provider=edge-tts|minimax
app.post('/sync', async (c) => {
  const provider = (c.req.query('provider') || 'edge-tts').toLowerCase()

  // 从数据库获取音频配置；edge-tts 允许无库配置（默认本地）
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(r => r.isActive && r.provider.toLowerCase() === provider)

  const config = rows[0] || {
    provider,
    baseUrl: provider === 'edge-tts' || provider === 'edge' || provider === 'edgetts'
      ? 'http://127.0.0.1:8791'
      : '',
    apiKey: 'local',
  }

  if (provider === 'minimax' && !config.apiKey) {
    return badRequest(c, 'MiniMax API key not configured')
  }

  // 调用 get_voice API（edge-tts / minimax 兼容）
  const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey || 'local'}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ voice_type: 'all' }),
  })

  if (!resp.ok) {
    return badRequest(c, `Voice API error (${provider}): ${resp.status}`)
  }

  const result = await resp.json() as any
  if (result.base_resp && result.base_resp.status_code !== 0) {
    return badRequest(c, result.base_resp?.status_msg || 'Failed to fetch voices')
  }

  const voices = (result.system_voice || []).filter((v: any) => shouldKeepVoice(v))
  const ts = now()
  const providerName = provider === 'edge' || provider === 'edgetts' ? 'edge-tts' : provider

  // 先清空该 provider 旧数据
  db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, providerName)).run()

  // 批量插入新数据
  const insertRows = voices.map((v: any) => ({
    voiceId: v.voice_id,
    voiceName: v.voice_name,
    description: JSON.stringify(v.description || []),
    language: extractLanguage(v.voice_id, v.voice_name),
    provider: providerName,
    createdAt: ts,
  }))

  if (insertRows.length > 0) {
    db.insert(schema.aiVoices).values(insertRows).run()
  }

  return success(c, { count: insertRows.length, message: `Synced ${insertRows.length} voices` })
})

/**
 * 从 voice_id 或 voice_name 推断语言
 */
function extractLanguage(voiceId: string, voiceName: string): string {
  const text = `${voiceId} ${voiceName}`.toLowerCase()
  if (text.includes('cantonese') || text.includes('粤') || text.includes('zh-hk')) return '粤语'
  if (text.includes('english') || text.includes('aussie') || text.startsWith('en-')) return '英语'
  if (text.includes('japanese') || text.includes('日语') || text.startsWith('ja-')) return '日语'
  if (text.includes('korean') || text.includes('韩') || text.startsWith('ko-')) return '韩语'
  if (text.includes('spanish') || text.startsWith('es-')) return '西班牙语'
  if (text.includes('portuguese') || text.startsWith('pt-')) return '葡萄牙语'
  if (text.includes('french') || text.startsWith('fr-')) return '法语'
  if (text.includes('indonesian') || text.startsWith('id-')) return '印尼语'
  if (text.includes('german') || text.startsWith('de-')) return '德语'
  if (text.includes('russian') || text.startsWith('ru-')) return '俄语'
  if (text.includes('italian') || text.startsWith('it-')) return '意大利语'
  if (text.includes('arabic') || text.startsWith('ar-')) return '阿拉伯语'
  if (text.includes('turkish') || text.startsWith('tr-')) return '土耳其语'
  if (text.includes('ukrainian') || text.startsWith('uk-')) return '乌克兰语'
  if (text.includes('dutch') || text.startsWith('nl-')) return '荷兰语'
  if (text.includes('vietnamese') || text.startsWith('vi-')) return '越南语'
  // edge-tts 中文：zh-CN / zh-TW / zh- 前缀
  if (
    text.includes('chinese')
    || text.includes('mandarin')
    || text.includes('中文')
    || text.includes('zh-cn')
    || text.includes('zh-tw')
    || text.startsWith('zh-')
  ) return '中文'
  return '其他'
}

function shouldKeepVoice(voice: { voice_id: string, voice_name: string }) {
  const language = extractLanguage(voice.voice_id, voice.voice_name)
  if (language !== '中文' && language !== '粤语') return false

  const text = `${voice.voice_id} ${voice.voice_name}`.toLowerCase()

  const excludedPatterns = [
    'jingpin',
    '-beta',
    'cartoon_pig',
    'cute_boy',
    'lovely_girl',
    'clever_boy',
    'robot_armor',
    'news_anchor',
    'male_announcer',
    'radio_host',
    'hk_flight_attendant',
  ]

  return !excludedPatterns.some(pattern => text.includes(pattern))
}

export default app

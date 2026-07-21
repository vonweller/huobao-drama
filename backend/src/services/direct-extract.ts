/**
 * 单轮对话提取角色/场景（不走多轮 Agent tools）
 * 用于中转服务对 multi-step tool calling 不稳定时的兜底。
 */
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

function linkCharToEpisode(episodeId: number, characterId: number) {
  const ts = now()
  const existing = db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))
    .all()
  if (!existing.length) {
    db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts }).run()
  }
}

function linkSceneToEpisode(episodeId: number, sceneId: number) {
  const ts = now()
  const existing = db.select().from(schema.episodeScenes)
    .where(and(eq(schema.episodeScenes.episodeId, episodeId), eq(schema.episodeScenes.sceneId, sceneId)))
    .all()
  if (!existing.length) {
    db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts }).run()
  }
}

function extractJsonObject(text: string): any {
  const cleaned = (text || '').trim()
  // 优先找 ```json ... ```
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence?.[1]?.trim() || cleaned
  // 找第一个 { 到最后一个 }
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1))
  }
  return JSON.parse(candidate)
}

export async function directExtractCharactersAndScenes(episodeId: number, dramaId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error('分集不存在')
  const script = (ep.scriptContent || ep.content || '').trim()
  if (!script) throw new Error('当前分集没有剧本内容，请先完成 AI 改写或填写原始内容')

  const textConfig = getTextConfig()
  const baseURL = getTextProviderBaseUrl(textConfig).replace(/\/+$/, '')
  const url = `${baseURL}/chat/completions`

  const prompt = `你是短剧制片助理。请从下面剧本中提取【角色】和【场景】，只返回 JSON，不要解释。

JSON 格式：
{
  "characters": [
    {"name":"角色名","role":"主角/配角/反派等","description":"简介","appearance":"外貌","personality":"性格"}
  ],
  "scenes": [
    {"location":"地点","time":"时间段","prompt":"场景视觉描述"}
  ]
}

要求：
1. 只提取本集真实出现或被明确提及的角色/场景
2. 角色名要准确，不要合并不同人
3. 场景按 地点+时间段 区分
4. 外貌/性格尽量从剧本文字推断，没有就写空字符串

剧本：
${script.slice(0, 12000)}`

  logTaskProgress('DirectExtract', 'chat-start', {
    episodeId,
    dramaId,
    provider: textConfig.provider,
    model: textConfig.model,
    url,
    scriptLength: script.length,
  })

  // 本地中转常见间歇 502，最多重试 3 次
  let rawText = ''
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${textConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: textConfig.model,
          messages: [
            { role: 'system', content: '你是严谨的结构化信息提取器，只输出合法 JSON。' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 2500,
        }),
        signal: AbortSignal.timeout(120_000),
      })
      rawText = await resp.text()
      if (resp.ok) break
      let msg = rawText.slice(0, 300)
      try {
        const j = JSON.parse(rawText)
        msg = j?.error?.message || j?.message || msg
      } catch {}
      lastErr = `文本模型调用失败(${resp.status}): ${msg}`
      logTaskError('DirectExtract', 'chat-attempt-failed', { attempt, status: resp.status, msg })
      if (resp.status === 502 || resp.status === 503 || resp.status === 429) {
        await new Promise(r => setTimeout(r, attempt * 1500))
        continue
      }
      throw new Error(lastErr)
    } catch (e: any) {
      lastErr = e.message || String(e)
      logTaskError('DirectExtract', 'chat-attempt-exception', { attempt, error: lastErr })
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1500))
        continue
      }
      throw new Error(lastErr)
    }
  }
  if (!rawText) throw new Error(lastErr || '文本模型无响应')

  let content = ''
  try {
    const j = JSON.parse(rawText)
    content = j?.choices?.[0]?.message?.content || ''
  } catch {
    content = rawText
  }

  let parsed: any
  try {
    parsed = extractJsonObject(content)
  } catch (e: any) {
    logTaskError('DirectExtract', 'parse-failed', { preview: content.slice(0, 300) })
    throw new Error(`模型返回无法解析为 JSON：${e.message}`)
  }

  const characters = Array.isArray(parsed.characters) ? parsed.characters : []
  const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : []
  const ts = now()
  const charStats = { created: 0, merged: 0 }
  const sceneStats = { created: 0, reused: 0 }

  for (const char of characters) {
    const name = String(char?.name || '').trim()
    if (!name) continue
    const existing = db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId)).all()
      .filter(c => !c.deletedAt)
      .find(c => c.name === name)

    if (existing) {
      db.update(schema.characters).set({
        role: char.role || existing.role,
        description: char.description || existing.description,
        appearance: char.appearance || existing.appearance,
        personality: char.personality || existing.personality,
        updatedAt: ts,
      }).where(eq(schema.characters.id, existing.id)).run()
      linkCharToEpisode(episodeId, existing.id)
      charStats.merged++
    } else {
      const res = db.insert(schema.characters).values({
        name,
        role: char.role || '',
        description: char.description || '',
        appearance: char.appearance || '',
        personality: char.personality || '',
        dramaId,
        createdAt: ts,
        updatedAt: ts,
      }).run()
      linkCharToEpisode(episodeId, Number(res.lastInsertRowid))
      charStats.created++
    }
  }

  for (const scene of scenes) {
    const location = String(scene?.location || '').trim()
    if (!location) continue
    const time = String(scene?.time || '')
    const existing = db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)).all()
      .filter(s => !s.deletedAt)
      .find(s => s.location === location && s.time === time)

    if (existing) {
      linkSceneToEpisode(episodeId, existing.id)
      sceneStats.reused++
    } else {
      const res = db.insert(schema.scenes).values({
        dramaId,
        location,
        time,
        prompt: scene.prompt || location,
        createdAt: ts,
        updatedAt: ts,
      }).run()
      linkSceneToEpisode(episodeId, Number(res.lastInsertRowid))
      sceneStats.created++
    }
  }

  const summary = {
    characters: charStats,
    scenes: sceneStats,
    totalCharacters: charStats.created + charStats.merged,
    totalScenes: sceneStats.created + sceneStats.reused,
  }
  logTaskSuccess('DirectExtract', 'done', { episodeId, dramaId, ...summary })
  return summary
}

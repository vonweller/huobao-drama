/**
 * 分镜拆解：优先单轮 LLM；失败时规则兜底，保证流程可继续。
 * 用于本地中转对 multi-step tools / 长请求不稳定的场景。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

type CharInfo = { id: number; name: string; role: string; appearance: string; personality: string }
type SceneInfo = { id: number; location: string; time: string; prompt: string }
type ShotDraft = {
  shot_number?: number
  title?: string
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  character_ids?: number[]
  scene_id?: number | null
  action?: string
  dialogue?: string
  description?: string
  result?: string
  atmosphere?: string
  image_prompt?: string
  video_prompt?: string
  bgm_prompt?: string
  sound_effect?: string
  duration?: number
}

function extractJsonObject(text: string): any {
  const cleaned = (text || '').trim()
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence?.[1]?.trim() || cleaned
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1))
  }
  return JSON.parse(candidate)
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()
  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

async function chatJson(prompt: string, maxTokens = 1600): Promise<any> {
  const textConfig = getTextConfig()
  const baseURL = getTextProviderBaseUrl(textConfig).replace(/\/+$/, '')
  const url = `${baseURL}/chat/completions`

  // 只请求 1 次；失败立即交给规则兜底，避免前端干等 2 分钟
  let rawText = ''
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
          { role: 'system', content: '你是资深影视分镜师。只输出合法 JSON，不要解释。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(25_000),
    })
    rawText = await resp.text()
    if (!resp.ok) {
      let msg = rawText.slice(0, 300)
      try {
        const j = JSON.parse(rawText)
        msg = j?.error?.message || j?.message || msg
      } catch {}
      throw new Error(`文本模型调用失败(${resp.status}): ${msg}`)
    }
  } catch (e: any) {
    throw new Error(e.message || String(e))
  }
  if (!rawText) throw new Error('文本模型无响应')

  let content = ''
  try {
    const j = JSON.parse(rawText)
    content = j?.choices?.[0]?.message?.content || ''
  } catch {
    content = rawText
  }
  try {
    return extractJsonObject(content)
  } catch (e: any) {
    throw new Error(`模型返回无法解析为 JSON：${e.message}`)
  }
}

/** 从剧本按段落/对白规则拆镜头（不依赖上游 LLM） */
function ruleBasedStoryboards(
  script: string,
  characters: CharInfo[],
  scenes: SceneInfo[],
): ShotDraft[] {
  const lines = script
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)

  // 粗分块：空行/场景头/对白切换
  const blocks: string[] = []
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      blocks.push(buf.join('\n'))
      buf = []
    }
  }
  for (const line of lines) {
    if (/^#{1,3}\s*S?\d+/i.test(line) || /^##\s*/.test(line) || /^(内景|外景|INT\.|EXT\.)/i.test(line)) {
      flush()
      buf.push(line)
      continue
    }
    // 对白行通常 “角色：内容”
    if (/^[\u4e00-\u9fa5A-Za-z0-9_（）()]{1,12}[:：]/.test(line) && buf.length >= 3) {
      flush()
    }
    buf.push(line)
    // 块太长强制切开
    if (buf.join('\n').length > 180) flush()
  }
  flush()

  // 若块太少，按固定长度切
  let units = blocks
  if (units.length < 4) {
    const plain = script.replace(/\s+/g, ' ').trim()
    units = []
    const chunk = Math.max(80, Math.ceil(plain.length / 8))
    for (let i = 0; i < plain.length; i += chunk) {
      units.push(plain.slice(i, i + chunk))
    }
  }

  // 控制在 6-12 镜
  if (units.length > 12) {
    const merged: string[] = []
    const step = Math.ceil(units.length / 10)
    for (let i = 0; i < units.length; i += step) {
      merged.push(units.slice(i, i + step).join('\n'))
    }
    units = merged
  }
  while (units.length < 6 && units.length > 0) {
    // 复制拆细最后几段
    const last = units[units.length - 1]
    if (last.length < 40) break
    const mid = Math.floor(last.length / 2)
    units[units.length - 1] = last.slice(0, mid)
    units.push(last.slice(mid))
  }

  const defaultScene = scenes[0]
  const shots: ShotDraft[] = []
  const shotTypes = ['全景', '中景', '近景', '特写', '中近景', '全景']

  for (let i = 0; i < units.length; i++) {
    const text = units[i]
    const characterIds: number[] = []
    for (const c of characters) {
      if (text.includes(c.name)) characterIds.push(c.id)
    }
    if (!characterIds.length && characters[0]) characterIds.push(characters[0].id)

    // 提取对白
    const dialogueLines = text
      .split('\n')
      .filter(l => /[:：]/.test(l) && l.length < 80)
      .slice(0, 2)
    const dialogue = dialogueLines.join(' / ')
    const action = text
      .split('\n')
      .filter(l => !/[:：]/.test(l) && !/^#/.test(l))
      .join(' ')
      .slice(0, 120) || text.slice(0, 120)

    const names = characters.filter(c => characterIds.includes(c.id)).map(c => c.name).join('、') || '角色'
    const loc = defaultScene?.location || '场景'
    const time = defaultScene?.time || '日'
    const title = (dialogueLines[0]?.split(/[:：]/)[1] || action).replace(/\s+/g, '').slice(0, 8) || `镜头${i + 1}`

    shots.push({
      shot_number: i + 1,
      title,
      shot_type: shotTypes[i % shotTypes.length],
      angle: i % 3 === 0 ? '俯视' : '平视',
      movement: i % 4 === 0 ? '推镜' : (i % 4 === 2 ? '跟拍' : '固定'),
      location: loc,
      time,
      character_ids: characterIds,
      scene_id: defaultScene?.id ?? null,
      action,
      dialogue,
      description: `第${i + 1}镜：${names} 在${loc}，${action.slice(0, 60)}`,
      result: i === units.length - 1 ? '段落收束' : '情绪推进到下一镜',
      atmosphere: defaultScene?.prompt || `${loc}，${time}，电影感光线`,
      image_prompt: `cinematic still, ${names}, at ${loc}, ${time}, ${action.slice(0, 80)}, high detail, no watermark`,
      video_prompt: `0-4s: ${names} at ${loc}, ${action.slice(0, 60)}.<n>4-8s: continue action, cinematic camera.`,
      bgm_prompt: i < units.length / 2 ? '悬疑氛围铺垫' : '紧张推进',
      sound_effect: dialogue ? '环境音+人声' : '环境音',
      duration: dialogue ? 12 : 10,
    })
  }

  return shots
}

function persistStoryboards(
  episodeId: number,
  storyboards: ShotDraft[],
  characters: CharInfo[],
  scenes: SceneInfo[],
) {
  const validCharIds = new Set(characters.map(c => c.id))
  const validSceneIds = new Set(scenes.map(s => s.id))
  const defaultSceneId = scenes[0]?.id ?? null
  const ts = now()

  const existingIds = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId)).all()
    .map(sb => sb.id)
  for (const id of existingIds) {
    db.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, id))
      .run()
  }
  db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()

  let totalDuration = 0
  let saved = 0
  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i] || {}
    const shotNumber = Number(sb.shot_number) || (i + 1)
    let sceneId = sb.scene_id == null || sb.scene_id === '' ? null : Number(sb.scene_id)
    if (sceneId != null && !validSceneIds.has(sceneId)) sceneId = defaultSceneId
    if (sceneId == null) sceneId = defaultSceneId

    let characterIds: number[] = Array.isArray(sb.character_ids)
      ? sb.character_ids.map((x: any) => Number(x)).filter((id: number) => validCharIds.has(id))
      : []
    if (!characterIds.length && typeof sb.dialogue === 'string') {
      for (const c of characters) {
        if (sb.dialogue.includes(c.name)) characterIds.push(c.id)
      }
    }
    if (!characterIds.length && characters[0]) characterIds = [characters[0].id]

    const duration = Math.max(5, Math.min(20, Number(sb.duration) || 12))
    const res = db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: shotNumber,
      title: sb.title || `镜头${shotNumber}`,
      shotType: sb.shot_type || '中景',
      angle: sb.angle || '平视',
      movement: sb.movement || '固定',
      location: sb.location || scenes[0]?.location || '',
      time: sb.time || scenes[0]?.time || '',
      action: sb.action || '',
      dialogue: sb.dialogue || '',
      description: sb.description || '',
      result: sb.result || '',
      atmosphere: sb.atmosphere || '',
      imagePrompt: sb.image_prompt || '',
      videoPrompt: sb.video_prompt || '',
      bgmPrompt: sb.bgm_prompt || '',
      soundEffect: sb.sound_effect || '',
      sceneId,
      duration,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    syncStoryboardCharacters(Number(res.lastInsertRowid), characterIds)
    totalDuration += duration
    saved++
  }

  db.update(schema.episodes)
    .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
    .where(eq(schema.episodes.id, episodeId)).run()

  return { count: saved, totalDuration }
}

export async function directBreakStoryboards(episodeId: number, dramaId: number) {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error('分集不存在')
  const script = (ep.scriptContent || ep.content || '').trim()
  if (!script) throw new Error('当前分集没有剧本内容')

  const charLinks = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const sceneLinks = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const linkedCharIds = new Set(charLinks.map(l => l.characterId))
  const linkedSceneIds = new Set(sceneLinks.map(l => l.sceneId))

  const characters = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, dramaId)).all()
    .filter(c => !c.deletedAt && (!linkedCharIds.size || linkedCharIds.has(c.id)))
    .map(c => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      appearance: c.appearance || '',
      personality: c.personality || '',
    }))

  const scenes = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, dramaId)).all()
    .filter(s => !s.deletedAt && (!linkedSceneIds.size || linkedSceneIds.has(s.id)))
    .map(s => ({
      id: s.id,
      location: s.location,
      time: s.time || '',
      prompt: s.prompt || '',
    }))

  if (!characters.length) {
    throw new Error('当前集还没有角色，请先完成角色提取')
  }

  const defaultSceneId = scenes[0]?.id ?? null
  const charCatalog = characters.map(c => `#${c.id}${c.name}`).join(';')
  const sceneCatalog = scenes.length
    ? scenes.map(s => `#${s.id}${s.location}`).join(';')
    : 'none'

  logTaskProgress('DirectStoryboard', 'start', {
    episodeId,
    dramaId,
    characters: characters.length,
    scenes: scenes.length,
    scriptLength: script.length,
  })

  let storyboards: ShotDraft[] = []
  let mode: 'llm' | 'rule' = 'llm'
  let llmError = ''

  // 1) 优先 LLM（短提示，失败快速回退）
  try {
    const prompt = `拆成6-10镜头,只返回JSON。角色:${charCatalog} 场景:${sceneCatalog}
{"storyboards":[{"shot_number":1,"title":"标题","shot_type":"中景","angle":"平视","movement":"固定","location":"地点","time":"时间","character_ids":[${characters[0].id}],"scene_id":${defaultSceneId ?? 'null'},"action":"动作","dialogue":"对白","description":"概述","result":"结果","atmosphere":"氛围","image_prompt":"en","video_prompt":"en","bgm_prompt":"bgm","sound_effect":"sfx","duration":12}]}
剧本:
${script.slice(0, 2500)}`
    const parsed = await chatJson(prompt, 1600)
    storyboards = Array.isArray(parsed.storyboards) ? parsed.storyboards : []
    if (!storyboards.length) throw new Error('模型未返回分镜列表')
    mode = 'llm'
  } catch (e: any) {
    llmError = e.message || String(e)
    logTaskError('DirectStoryboard', 'llm-failed-use-rule', { error: llmError })
    storyboards = ruleBasedStoryboards(script, characters, scenes)
    mode = 'rule'
  }

  if (!storyboards.length) {
    throw new Error('分镜生成失败：模型与规则兜底都没有产出镜头')
  }

  const summary = persistStoryboards(episodeId, storyboards, characters, scenes)
  logTaskSuccess('DirectStoryboard', 'done', {
    episodeId,
    dramaId,
    mode,
    ...summary,
    llmError: llmError || undefined,
  })
  return {
    ...summary,
    mode,
    note: mode === 'rule'
      ? `上游模型暂不可用（${llmError}），已用规则分镜兜底，可继续后续制作或稍后重试 AI 精修。`
      : 'AI 单轮拆解完成',
  }
}

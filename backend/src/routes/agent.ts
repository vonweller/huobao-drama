/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { createAgent, validAgentTypes } from '../agents/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { directExtractCharactersAndScenes } from '../services/direct-extract.js'
import { directBreakStoryboards } from '../services/direct-storyboard.js'

const app = new Hono()

function normalizeToolName(entry: any) {
  return entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.result ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `Invalid agent type: ${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, 'drama_id and episode_id are required')
  }

  const agent = createAgent(agentType, episode_id, drama_id)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent not found')
  }

  const startTime = performance.now()

  // extractor 默认走单轮兜底：本地中转对 multi-step tools 不稳定
  // 可通过 body.force_agent=true 强制走多轮 Agent
  if (agentType === 'extractor' && !body.force_agent) {
    try {
      logTaskProgress('Agent', 'extractor-direct-start', {
        dramaId: drama_id,
        episodeId: episode_id,
      })
      const summary = await directExtractCharactersAndScenes(Number(episode_id), Number(drama_id))
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
      logTaskSuccess('Agent', 'extractor-direct-done', { ...summary, elapsedSeconds: elapsed })
      return success(c, {
        type: 'done',
        mode: 'direct',
        text: `提取完成：角色 ${summary.totalCharacters}（新增 ${summary.characters.created}/合并 ${summary.characters.merged}），场景 ${summary.totalScenes}（新增 ${summary.scenes.created}/复用 ${summary.scenes.reused}）。`,
        toolCalls: [],
        toolResults: [],
        summary,
      })
    } catch (directErr: any) {
      logTaskError('Agent', 'extractor-direct-failed', { error: directErr.message })
      // 失败再回退到多轮 agent
      logTaskProgress('Agent', 'extractor-agent-fallback', { reason: directErr.message })
    }
  }

  // storyboard 默认单轮直提（避免中转 multi-step tools 502）
  if (agentType === 'storyboard_breaker' && !body.force_agent) {
    try {
      logTaskProgress('Agent', 'storyboard-direct-start', {
        dramaId: drama_id,
        episodeId: episode_id,
      })
      const summary = await directBreakStoryboards(Number(episode_id), Number(drama_id))
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
      logTaskSuccess('Agent', 'storyboard-direct-done', { ...summary, elapsedSeconds: elapsed })
      const modeLabel = summary.mode === 'rule' ? '规则兜底' : 'AI直提'
      return success(c, {
        type: 'done',
        mode: summary.mode === 'rule' ? 'rule_fallback' : 'direct',
        text: `分镜拆解完成（${modeLabel}）：${summary.count} 个镜头，总时长约 ${summary.totalDuration} 秒。${summary.note ? '\n' + summary.note : ''}`,
        toolCalls: [],
        toolResults: [],
        summary,
      })
    } catch (directErr: any) {
      logTaskError('Agent', 'storyboard-direct-failed', { error: directErr.message })
      // 直提（含规则兜底）失败才回退多轮 agent；通常不应到这里
      logTaskProgress('Agent', 'storyboard-agent-fallback', { reason: directErr.message })
      return badRequest(c, `分镜拆解失败：${directErr.message}`)
    }
  }

  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      { maxSteps: 20 },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    const rawMsg = err?.message || 'Agent execution failed'
    const responseBody = err?.responseBody || err?.data?.error?.message || ''

    // 多轮 tools 被中转 502 时，自动降级单轮直提
    const isUpstream = /连接上游服务失败|upstream_network_error|502|Bad Gateway/i.test(`${rawMsg} ${responseBody}`)
    if (agentType === 'extractor' && isUpstream) {
      try {
        logTaskProgress('Agent', 'extractor-fallback-start', {
          dramaId: drama_id,
          episodeId: episode_id,
          reason: rawMsg,
        })
        const summary = await directExtractCharactersAndScenes(Number(episode_id), Number(drama_id))
        const fallbackElapsed = ((performance.now() - startTime) / 1000).toFixed(1)
        logTaskSuccess('Agent', 'extractor-fallback-done', { ...summary, elapsedSeconds: fallbackElapsed })
        return success(c, {
          type: 'done',
          mode: 'direct_fallback',
          text: `已使用单轮提取兜底完成：角色 ${summary.totalCharacters}（新增 ${summary.characters.created}/合并 ${summary.characters.merged}），场景 ${summary.totalScenes}（新增 ${summary.scenes.created}/复用 ${summary.scenes.reused}）。\n说明：多轮 Agent 工具调用被上游中转拒绝（${rawMsg}），已自动切换稳妥模式。`,
          toolCalls: [],
          toolResults: [],
          summary,
        })
      } catch (fallbackErr: any) {
        logTaskError('Agent', 'extractor-fallback-failed', { error: fallbackErr.message })
        const fe = fallbackErr.message || rawMsg
        return badRequest(
          c,
          `提取失败。中转返回：${rawMsg}。兜底提取也失败：${fe}`,
        )
      }
    }

    if (agentType === 'storyboard_breaker' && isUpstream) {
      try {
        logTaskProgress('Agent', 'storyboard-fallback-start', {
          dramaId: drama_id,
          episodeId: episode_id,
          reason: rawMsg,
        })
        const summary = await directBreakStoryboards(Number(episode_id), Number(drama_id))
        const fallbackElapsed = ((performance.now() - startTime) / 1000).toFixed(1)
        logTaskSuccess('Agent', 'storyboard-fallback-done', { ...summary, elapsedSeconds: fallbackElapsed })
        const modeLabel = summary.mode === 'rule' ? '规则兜底' : 'AI直提'
        return success(c, {
          type: 'done',
          mode: summary.mode === 'rule' ? 'rule_fallback' : 'direct_fallback',
          text: `已使用${modeLabel}完成分镜：${summary.count} 个镜头，总时长约 ${summary.totalDuration} 秒。\n说明：多轮 Agent 被上游拒绝（${rawMsg}）。${summary.note || ''}`,
          toolCalls: [],
          toolResults: [],
          summary,
        })
      } catch (fallbackErr: any) {
        logTaskError('Agent', 'storyboard-fallback-failed', { error: fallbackErr.message })
        return badRequest(
          c,
          `分镜拆解失败。中转返回：${rawMsg}。兜底也失败：${fallbackErr.message || rawMsg}`,
        )
      }
    }

    // 给前端更可读的错误提示
    let friendly = rawMsg
    if (/连接上游服务失败|upstream_network_error/i.test(rawMsg)) {
      friendly = `中转服务连不上上游模型（${rawMsg}）。设置页测试通过只代表 /models 列表正常；提取会发多轮 chat+tools 请求。请检查本地中转是否支持 tool calling，或换更稳定的文本模型。`
    } else if (/ECONNREFUSED|fetch failed|connect/i.test(rawMsg)) {
      friendly = `文本模型连接失败：${rawMsg}。请检查设置页「文本服务」的 Base URL / API Key 是否可用。`
    } else if (/401|Unauthorized|api key|invalid.*key/i.test(rawMsg)) {
      friendly = `文本模型鉴权失败：${rawMsg}。请检查 API Key。`
    } else if (/timeout|ETIMEDOUT|aborted/i.test(rawMsg)) {
      friendly = `文本模型超时：${rawMsg}。可稍后重试，或换更快的模型。`
    } else if (/No active.*text|no text/i.test(rawMsg)) {
      friendly = '未配置文本模型。请先在设置页添加并启用文本服务。'
    }
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: friendly, raw: rawMsg })
    console.error(err.stack || err)
    return badRequest(c, friendly)
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, 'Invalid agent type')
  return success(c, { agent_type: agentType, valid: true })
})

export default app

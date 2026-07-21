import { toast } from 'vue-sonner'
import { api } from './useApi'

export type AgentStatus = {
  phase: 'idle' | 'preparing' | 'running' | 'success' | 'error'
  type: string | null
  message: string
  detail: string
  elapsedMs: number
  toolNames: string[]
  error: string | null
  startedAt: number | null
}

const PHASE_TIPS: Record<string, string[]> = {
  extractor: [
    '读取格式化剧本…',
    '对照项目已有角色与场景…',
    '分析本集出场角色…',
    '提取场景地点与时间段…',
    '去重合并并写入数据库…',
  ],
  script_rewriter: [
    '读取原始内容…',
    '整理剧情结构…',
    '改写为格式化剧本…',
    '保存改写结果…',
  ],
  voice_assigner: [
    '读取角色列表…',
    '匹配可用音色…',
    '为角色分配音色…',
    '保存分配结果…',
  ],
  storyboard_breaker: [
    '读取剧本与角色场景…',
    '拆解镜头序列…',
    '生成画面与视频提示词…',
    '保存分镜结果…',
  ],
}

function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}分${r}秒` : `${r}秒`
}

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const status = ref<AgentStatus>({
    phase: 'idle',
    type: null,
    message: '',
    detail: '',
    elapsedMs: 0,
    toolNames: [],
    error: null,
    startedAt: null,
  })

  let timer: ReturnType<typeof setInterval> | null = null

  function clearTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function startTimer(type: string) {
    clearTimer()
    const tips = PHASE_TIPS[type] || ['AI 处理中…']
    const startedAt = Date.now()
    status.value = {
      phase: 'running',
      type,
      message: tips[0],
      detail: '请求已发送，等待模型返回（首次可能较慢）',
      elapsedMs: 0,
      toolNames: [],
      error: null,
      startedAt,
    }
    timer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      status.value.elapsedMs = elapsed
      // 按时间推进提示，避免一直卡同一句
      const idx = Math.min(tips.length - 1, Math.floor(elapsed / 8000))
      status.value.message = tips[idx]
      if (elapsed > 15000 && elapsed < 16000) {
        status.value.detail = '仍在等待模型，请稍候…'
      } else if (elapsed > 45000 && elapsed < 46000) {
        status.value.detail = '耗时较长，可能是模型响应慢或网络不稳'
      } else if (elapsed > 90000 && elapsed < 91000) {
        status.value.detail = '已超过 90 秒，若长时间无结果请检查文本模型配置'
      }
    }, 500)
  }

  async function run(
    type: string,
    msg: string,
    dramaId: number,
    episodeId: number,
    onDone?: () => void | Promise<void>,
  ) {
    if (running.value) {
      toast.warning('已有操作执行中，请稍候')
      return null
    }
    if (!dramaId || !episodeId) {
      toast.error('缺少项目或分集信息，无法执行')
      return null
    }

    running.value = true
    runningType.value = type
    startTimer(type)
    toast.message('已开始执行', { description: status.value.message })

    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
      })

      clearTimer()
      const toolNames = [
        ...((data?.toolCalls || []).map((t: any) => t.toolName).filter(Boolean)),
        ...((data?.toolResults || []).map((t: any) => t.toolName).filter(Boolean)),
      ]
      const uniqueTools = Array.from(new Set(toolNames))
      const elapsedMs = status.value.startedAt ? Date.now() - status.value.startedAt : 0

      status.value = {
        phase: 'success',
        type,
        message: '执行完成',
        detail: uniqueTools.length
          ? `已调用工具：${uniqueTools.join('、')} · 耗时 ${formatElapsed(elapsedMs)}`
          : `耗时 ${formatElapsed(elapsedMs)}`,
        elapsedMs,
        toolNames: uniqueTools,
        error: null,
        startedAt: status.value.startedAt,
      }

      toast.success('完成', {
        description: status.value.detail,
        duration: 4000,
      })

      await onDone?.()
      return data
    } catch (err: any) {
      clearTimer()
      const elapsedMs = status.value.startedAt ? Date.now() - status.value.startedAt : 0
      const errorMsg = err?.message || 'Agent 执行失败'
      status.value = {
        phase: 'error',
        type,
        message: '执行失败',
        detail: errorMsg,
        elapsedMs,
        toolNames: [],
        error: errorMsg,
        startedAt: status.value.startedAt,
      }
      toast.error('失败：' + errorMsg, { duration: 8000 })
      return null
    } finally {
      running.value = false
      runningType.value = null
      // 保留 success/error 状态供 UI 展示，3 秒后若仍非 running 则回到 idle 细节
      setTimeout(() => {
        if (!running.value && status.value.phase !== 'running') {
          // keep last status for panel, no forced clear
        }
      }, 0)
    }
  }

  function resetStatus() {
    clearTimer()
    status.value = {
      phase: 'idle',
      type: null,
      message: '',
      detail: '',
      elapsedMs: 0,
      toolNames: [],
      error: null,
      startedAt: null,
    }
  }

  return { running, runningType, status, run, resetStatus, formatElapsed }
}

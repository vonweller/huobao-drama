/**
 * Bernini 本地视频 Adapter
 * 对接本地服务 /v1/video_generation
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class BerniniVideoAdapter implements VideoProviderAdapter {
  provider = 'bernini'

  /**
   * 构建视频生成请求。
   */
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const content: any[] = [{ type: 'text', text: record.prompt || '' }]
    if (record.imageUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: record.imageUrl },
        role: 'reference_image',
      })
    } else if (record.firstFrameUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: record.firstFrameUrl },
        role: 'first_frame',
      })
    }

    return {
      url: joinProviderUrl(config.baseUrl || 'http://127.0.0.1:8790', '/v1', '/video_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'local'}`,
      },
      body: {
        model: record.model || config.model || 'bernini-r-1.3b',
        content,
        prompt: record.prompt,
        image_url: record.imageUrl || record.firstFrameUrl || null,
        duration: record.duration || 2,
        aspect_ratio: record.aspectRatio || '9:16',
      },
    }
  }

  /**
   * 解析创建任务响应。
   */
  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.task_id || result.id
    if (!taskId) {
      if (result.video_url) return { isAsync: false, videoUrl: result.video_url }
      throw new Error('No task_id in Bernini video response')
    }
    return { isAsync: true, taskId }
  }

  /**
   * 构建任务轮询请求。
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl || 'http://127.0.0.1:8790', '/v1', `/video_generation/task/${taskId}`),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey || 'local'}`,
      },
      body: undefined,
    }
  }

  /**
   * 解析轮询响应。
   */
  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'completed' || status === 'succeeded') {
      return {
        status: 'completed',
        videoUrl: result.video_url || result.data?.video_url || null,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: result.error || 'failed' }
    }
    return { status: 'processing' }
  }

  /**
   * 提取视频 URL。
   */
  extractVideoUrl(result: any): string | null {
    return result.video_url || result.data?.video_url || null
  }
}

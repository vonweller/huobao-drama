/**
 * Bernini 本地图片 Adapter
 * 默认走异步队列：POST /v1/images/generations -> task_id
 * 再轮询 GET /v1/images/task/:id
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

export class BerniniImageAdapter implements ImageProviderAdapter {
  provider = 'bernini'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = record.size || '512x512'
    return {
      url: joinProviderUrl(config.baseUrl || 'http://127.0.0.1:8790', '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey || 'local'}`,
      },
      body: {
        model: record.model || config.model || 'bernini-r-1.3b',
        prompt: record.prompt,
        size,
        n: 1,
        response_format: 'url',
        // 异步队列，便于进度显示 + 串行推理
        async: true,
      },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 异步队列
    if (result.task_id) {
      return { isAsync: true, taskId: result.task_id }
    }
    // 同步兼容
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    throw new Error('No image URL or task_id in Bernini response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl || 'http://127.0.0.1:8790', '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey || 'local'}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status
    if (status === 'completed' || status === 'succeeded') {
      return {
        status: 'completed',
        imageUrl: result.image_url || result.data?.[0]?.url || null,
      }
    }
    if (status === 'failed') {
      return { status: 'failed', error: result.error || result.message || 'failed' }
    }
    // queued / processing
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}

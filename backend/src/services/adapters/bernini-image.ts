/**
 * Bernini 本地图片 Adapter
 * 对接本地服务 http://127.0.0.1:8790/v1/images/generations
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

  /**
   * 构建文生图请求。
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = record.size || '480x848'
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
      },
    }
  }

  /**
   * 解析同步图片响应。
   */
  parseGenerateResponse(result: any): ImageGenResponse {
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    if (result.task_id) {
      return { isAsync: true, taskId: result.task_id }
    }
    throw new Error('No image URL in Bernini response')
  }

  /**
   * 构建轮询请求（当前 t2i 同步，保留兼容）。
   */
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

  /**
   * 解析轮询响应。
   */
  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'completed') {
      return { status: 'completed', imageUrl: result.image_url || result.data?.[0]?.url }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error || 'failed' }
    }
    return { status: 'processing' }
  }

  /**
   * 提取图片 URL。
   */
  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  /**
   * Bernini 本地服务返回 URL，不走 base64。
   */
  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}

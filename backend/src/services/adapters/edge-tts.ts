/**
 * Edge-TTS 本地语音合成 Adapter
 * 对接本地服务 http://127.0.0.1:8791/v1/t2a_v2
 * 响应格式兼容 MiniMax，可直接复用现有 hex 解码逻辑
 */
import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export interface EdgeTTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export class EdgeTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'edge-tts'

  /**
   * 构建本地 edge-tts 请求。
   */
  buildGenerateRequest(config: any, params: EdgeTTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
  } {
    const url = joinProviderUrl(config.baseUrl || 'http://127.0.0.1:8791', '/v1', '/t2a_v2')
    return {
      url,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey || 'local'}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: params.model || 'edge-tts',
        text: params.text,
        stream: false,
        voice_setting: {
          voice_id: params.voice || 'zh-CN-YunxiNeural',
          speed: params.speed ?? 1,
          emotion: params.emotion || 'neutral',
        },
        audio_setting: {
          sample_rate: 24000,
          bitrate: 48000,
          format: 'mp3',
          channel: 1,
        },
      },
    }
  }

  /**
   * 解析本地 edge-tts 响应（MiniMax 兼容）。
   */
  parseResponse(result: any): {
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  } {
    if (result.base_resp && result.base_resp.status_code !== 0) {
      throw new Error(result.base_resp?.status_msg || 'Edge-TTS generation failed')
    }
    const data = result.data
    if (!data?.audio) {
      throw new Error('No audio data in Edge-TTS response')
    }
    return {
      audioHex: data.audio,
      audioLength: data.extra_info?.audio_length || 0,
      sampleRate: data.extra_info?.audio_sample_rate || 24000,
      bitrate: data.extra_info?.bitrate || 48000,
      format: data.extra_info?.audio_format || 'mp3',
      channel: data.extra_info?.audio_channel || 1,
    }
  }
}

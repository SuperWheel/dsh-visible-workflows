import type { AgentTaskEvent } from '../shared/types.ts'

/** A display projection, never a transcript export or credential isolation boundary. */
export function safeTaskSummary(value: string, limit = 2000): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '[凭据已隐藏]')
    .replace(/\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/g, '[凭据已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|密码|密钥)\s*["']?\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；}]+)/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[凭据已隐藏]@')
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]*/gi, '$1[已隐藏]')
    .slice(0, limit)
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only allowlisted metadata and public assistant text may cross into the workflow UI. */
export function projectNativeEvent(type: string, raw: unknown): Pick<AgentTaskEvent, 'kind' | 'summary'> | undefined {
  const data = object(raw)
  if (type === 'step/start') return { kind: 'step', summary: `开始执行步骤${Number.isSafeInteger(data.step) ? ` ${data.step}` : ''}` }
  if (type === 'step/end') return { kind: 'step', summary: `完成步骤${Number.isSafeInteger(data.step) ? ` ${data.step}` : ''}` }
  if (type === 'tool/call') return { kind: 'tool', summary: `调用工具：${safeTaskSummary(typeof data.name === 'string' ? data.name : '未知工具', 160)}` }
  if (type === 'tool/result') return { kind: 'tool', summary: object(data.message).isError === true ? '工具执行失败' : '工具执行完成' }
  if (type === 'assistant/attempt') return { kind: 'message', summary: '模型尝试已结算；本次未产生完整回复' }
  if (type === 'assistant/message') {
    const content = object(data.message).content
    const text = Array.isArray(content) ? content.filter(block => object(block).type === 'text').map(block => object(block).text).filter((text): text is string => typeof text === 'string').join('\n') : ''
    return { kind: 'message', summary: text ? `助手回复：${safeTaskSummary(text, 1800)}` : '助手已完成本步骤回复' }
  }
  return undefined
}

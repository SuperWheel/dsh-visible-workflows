import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ModelBackend } from './runtime.ts'
import type { ModelChoice } from '../shared/types.ts'

/** A broken provider/model must not hide unrelated valid routes; callers decide how to display diagnostics. */
export async function modelCatalog(llm: Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo'>): Promise<{ choices: ModelChoice[]; failures: string[] }> {
  const choices: ModelChoice[] = [], failures: string[] = []
  for (const provider of llm.listProviders()) {
    let models: Awaited<ReturnType<LlmRuntime['listModels']>>
    try { models = await llm.listModels(provider.id) }
    catch { failures.push(`${provider.name}：模型目录暂不可用`); continue }
    for (const model of models) {
      try {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        choices.push({ provider: provider.id, model: model.id, label: `${model.name} · ${provider.name}`, efforts: resolved.reasoning?.efforts.map(e => ({ id: e.id, label: e.name })) ?? [] })
      } catch { failures.push(`${model.name} · ${provider.name}：无法读取模型能力`) }
    }
  }
  return { choices, failures }
}

/** All real model I/O goes through Harness's configured provider adapter. */
export function harnessModels(llm: LlmRuntime): ModelBackend {
  return {
    async generate({ model, effort, prompt, system, signal }) {
      signal.throwIfAborted()
      const catalog = await llm.listModels(model.provider)
      if (!catalog.some(choice => choice.id === model.model)) throw new Error('此模型已不在宿主可用目录中，请重新选择')
      const resolved = await llm.resolveModelInfo(model.provider, model.model, signal)
      if (effort && !resolved.reasoning?.efforts.some(item => item.id === effort)) throw new Error('所选思考强度不受此模型支持，请重新选择')
      let text = '', finished = false
      for await (const chunk of llm.stream({
        provider: model.provider, model: model.model, ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
        system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal,
      })) {
        signal.throwIfAborted()
        if (chunk.type === 'text-delta') { text += chunk.text; if (text.length > 1_000_000) throw new Error('模型输出超过 1 MB 限制') }
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new Error(`[${chunk.reason.failure.code}] ${chunk.reason.failure.message}`)
          if (chunk.reason.kind === 'max-tokens') throw new Error('模型输出达到上限，结果不完整；请缩短输入或调整模型设置')
          if (chunk.reason.kind !== 'stop') throw new Error('此模型返回了当前节点不支持的工具调用结果')
        }
      }
      if (!finished) throw new Error('模型流意外结束，未收到完成标记')
      return text
    },
  }
}

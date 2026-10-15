import type { ModelChoice, NodeConfig } from '../shared/types.ts'
import { Field, Select } from './controls.tsx'

export interface ModelSettingsProps {
  config: NodeConfig
  models: readonly ModelChoice[]
  modelsError?: string
  disabled?: boolean
  onChange(patch: Partial<NodeConfig>): void
}

const modelKey = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model])

/** Undefined is a deliberate runtime inheritance policy, never the first catalog entry. */
export function ModelSettings({ config, models, modelsError, disabled = false, onChange }: ModelSettingsProps) {
  const selectedId = config.model ? modelKey(config.model) : ''
  const selected = config.model ? models.find(model => modelKey(model) === selectedId) : undefined
  const modelOptions = [{ id: '', label: '跟随 DSH' }, ...models.map(model => ({ id: modelKey(model), label: model.label }))]
  if (config.model && !selected) modelOptions.push({ id: selectedId, label: `${config.model.model} · ${config.model.provider}（暂不在目录）` })
  const effortOptions = [{ id: '', label: config.model ? '默认设置' : '跟随 DSH' }, ...(selected?.efforts ?? [])]
  const unsupportedEffort = !!config.effort && !!selected && !selected.efforts.some(effort => effort.id === config.effort)
  if (config.effort && !effortOptions.some(effort => effort.id === config.effort)) {
    effortOptions.push({ id: config.effort, label: `${config.effort}${unsupportedEffort ? '（当前模型不支持）' : '（已指定）'}` })
  }
  const modelHelp = modelsError ? `模型目录读取失败：${modelsError}。保留当前配置，默认模型仍由 DSH 解析。`
    : config.model && !selected ? '保留已指定模型；如该配置已删除，请重新选择或跟随 DSH。'
      : '优先使用当前对话模型，无对话时使用 DSH 默认模型。也可为此节点指定模型。'
  const effortHelp = unsupportedEffort ? '当前模型不支持已指定的思考强度，请重新选择；不会自动替换。'
    : !config.model ? config.effort ? '保留已指定强度，执行时由 DSH 当前模型校验是否支持。' : '沿用 DSH 当前模型的思考强度。需要单独选择强度时，请先指定模型。'
      : !selected ? '模型能力暂不可用，保留当前强度，执行前由宿主校验。'
        : '与 DSH 当前模型相同时沿用其强度；其他模型使用自身默认设置。'
  return <>
    <Field label="模型" help={modelHelp} helpVisible={!!modelsError || !!config.model && !selected}><Select label="选择模型" value={selectedId} disabled={disabled} options={modelOptions} onChange={id => {
      if (id === '') { onChange({ model: undefined }); return }
      const model = models.find(item => modelKey(item) === id)
      if (model) onChange({ model: { provider: model.provider, model: model.model } })
    }}/></Field>
    <Field label="思考强度" help={effortHelp} helpVisible={unsupportedEffort || !!config.model && !selected}><Select label="选择思考强度" value={config.effort ?? ''}
      disabled={disabled || (!selected?.efforts.length && !config.effort)} options={effortOptions}
      onChange={id => onChange({ effort: id || undefined })}/></Field>
  </>
}

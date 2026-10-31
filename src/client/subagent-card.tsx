import { t, useLocale } from './i18n.ts'
import { useEffect, useId, useState } from 'react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RolePreset, Workflow, WorkflowNode, WorkflowSubagent } from '../shared/types.ts'
import { bindNodeSubagent, createWorkflowSubagent, subagentForNode, subagentInSession } from '../shared/workflow-subagents.ts'
import { Field, Select } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { PromptEditor } from './prompt-editor.tsx'
import { rolePresetsForWorkflow } from '../shared/role-presets.ts'

export function SubagentCard({flow,node,presets,sessionId,disabled=false,onChange}:{flow:Workflow;node:WorkflowNode;presets:readonly RolePreset[];sessionId?:string;disabled?:boolean;onChange:(update:(flow:Workflow)=>void)=>void;onSettings:()=>void}) {useLocale();
  const selected=subagentForNode(flow,node),[name,setName]=useState(selected?.name??''),[open,setOpen]=useState(false),[query,setQuery]=useState(''),[error,setError]=useState(''),listId=useId()
  useEffect(()=>{setName(selected?.name??'');setOpen(false);setError('')},[selected?.id,selected?.name,node.id,sessionId])
  const available=(flow.subAgents??[]).filter(agent=>subagentInSession(agent,sessionId)),trimmed=name.trim(),exact=available.find(agent=>agent.name===trimmed),foreignName=(flow.subAgents??[]).find(agent=>agent.name===trimmed&&!subagentInSession(agent,sessionId)),canCreate=!!trimmed&&!exact&&!foreignName,eligible=!!selected&&subagentInSession(selected,sessionId)
  const matches=available.filter(agent=>agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())||agent.number.includes(query.trim()))
  const choose=(definition:WorkflowSubagent)=>{if(disabled)return;setError('');try{onChange(draft=>bindNodeSubagent(draft,node.id,definition,sessionId));setName(definition.name);setOpen(false)}catch(error){setError(error instanceof Error?error.message:String(error))}}
  const create=()=>{if(disabled||!canCreate)return;try{choose(createWorkflowSubagent(flow,trimmed,sessionId))}catch(error){setError(error instanceof Error?error.message:String(error))}}
  const patch=(update:Partial<WorkflowSubagent>)=>{if(disabled||!eligible)return;onChange(draft=>{const definition=draft.subAgents?.find(agent=>agent.id===selected.id);if(!definition)throw new Error('子 Agent 已变化，请重新选择');bindNodeSubagent(draft,node.id,{...definition,...update},sessionId)})}
  const applicablePresets=rolePresetsForWorkflow(presets,flow.id),preset=applicablePresets.find(preset=>preset.id===selected?.rolePresetId),presetChanged=!!preset&&(preset.revision!==selected?.rolePresetRevision||preset.prompt!==selected?.prompt)
  const applyPreset=(id:string)=>{const preset=applicablePresets.find(item=>item.id===id);if(id&&!preset)return;patch(preset?{rolePresetId:preset.id,rolePresetRevision:preset.revision,prompt:preset.prompt}:{rolePresetId:undefined,rolePresetRevision:undefined,prompt:''})}
  return <section className="vdw-subagent-card" aria-label={t("子 Agent")}>
    <div className="vdw-between"><strong>{t("子 Agent")}</strong>{selected&&<small title={selected.id}>{selected.number}</small>}</div>
    <Field label={t("名称")} help={t("选择当前工作流、当前主对话中的子 Agent。输入新名称后点击加号创建。")}>
      <div className="vdw-subagent-combobox" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOpen(false)}}>
        <div className="vdw-subagent-input"><Input aria-label={t("子 Agent 名称")} role="combobox" aria-autocomplete="list" aria-expanded={open&&!disabled} aria-controls={listId} value={name} maxLength={100} disabled={disabled} placeholder={t("选择或输入子 Agent 名称")} onFocus={()=>{setQuery('');setOpen(true)}} onChange={event=>{setName(event.target.value);setQuery(event.target.value);setOpen(true);setError('')}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false)}if(event.key==='ArrowDown'){event.preventDefault();setOpen(true)}if(event.key==='Enter'){event.preventDefault();if(canCreate)create();else if(exact)choose(exact)}}}/>
          <Tooltip side="bottom" maxWidth={300} label={canCreate?t("创建子 Agent"):t("选择子 Agent")} portal><Button className="vdw-icon-button" size="sm" aria-label={canCreate?t("创建子 Agent"):t("展开子 Agent 列表")} disabled={disabled} onClick={()=>{if(canCreate)create();else{setQuery('');setOpen(!open)}}}><Glyph name={canCreate?'plus':'chevron-down'}/></Button></Tooltip>
        </div>
        {open&&!disabled&&<div id={listId} role="listbox" aria-label={t("可选子 Agent")} className="vdw-subagent-options">
          {(query.trim()?matches:available).map(agent=><button key={agent.id} type="button" role="option" aria-selected={selected?.id===agent.id} onClick={()=>choose(agent)}><span>{agent.name}</span><small>{agent.number}</small></button>)}
          {!(query.trim()?matches:available).length&&<p className="vdw-muted">{foreignName?t("此名称属于其他主对话，请使用新名称"):canCreate?t("点击加号创建这个子 Agent"):t("还没有子 Agent，请输入名称创建")}</p>}
        </div>}
      </div>
    </Field>
    {!selected&&<p className="vdw-muted">{t("为此节点选择或创建一个子 Agent。")}</p>}
    {selected&&!eligible&&<p className="vdw-error">{t("此身份属于其他主对话。请输入名称，为当前对话创建子 Agent。")}</p>}
    {eligible&&<>
      <Field label={t("角色预设")} help={t("选择后将角色提示词复制到此子 Agent。同一工作流中引用此身份的节点共同使用这份角色。")}><Select label={t("选择子 Agent 角色预设")} value={selected.rolePresetId??''} disabled={disabled} options={[{id:'',label:t("不使用角色预设")},...applicablePresets.map(preset=>({id:preset.id,label:preset.name})),...(selected.rolePresetId&&!preset?[{id:selected.rolePresetId,label:t("原预设不可用（保留角色提示词）")}]:[])]} onChange={applyPreset}/>{presetChanged&&<Button className="vdw-subagent-preset-update" size="sm" disabled={disabled} onClick={()=>applyPreset(preset.id)}>{t("更新预设内容")}</Button>}</Field>
      <PromptEditor role="SYSTEM" label={t("子 Agent 角色提示词")} value={selected.prompt} disabled={disabled} rows={4} onChange={prompt=>patch({prompt,rolePresetId:undefined,rolePresetRevision:undefined})} help={t("保存在工作流内，随 JSON 一起导出。留空表示不额外设置角色。预设更新不会自动改变这份内容。")}/>
      <p className="vdw-muted">{t("此身份仅用于当前工作流和主对话。同一身份复用角色配置，每次执行创建独立任务。")}</p>
    </>}
    {error&&<p className="vdw-error" role="alert">{error}</p>}
  </section>
}

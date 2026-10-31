import { displayNodeNumber } from './annotation-nodes.ts'
import { useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_LABELS, type Workflow, type WorkflowNode } from '../shared/types.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { Glyph } from './icons.tsx'
import { Field, HelpButton, Select } from './controls.tsx'
import { PromptEditor } from './prompt-editor.tsx'
import { SpecificConfig } from './node-config.tsx'
import { allNodes, availableNodes, definition, isModelNode, nodePorts } from './nodes.ts'
import { NodeBadge } from './node-picker.tsx'
import { ModelSettings } from './model-settings.tsx'
import { VariableBrowser } from './variable-browser.tsx'
import { ExecutionDetails } from './execution-details.tsx'
import { SubagentCard } from './subagent-card.tsx'
import { HttpCacheSettings } from './http-cache-settings.tsx'
import { SaveSettings } from './save-settings.tsx'
import { t, useLocale } from './i18n.ts'
import { rolePresetsForWorkflow } from '../shared/role-presets.ts'
import { workflowSettingsStyles } from './workflow-settings-style.ts'
export { Field, Select } from './controls.tsx'
export function NodePanel({node,flow,store,onClose,disabled,onSettings,onEdit,onEnter}:{node:WorkflowNode;flow:Workflow;store:WorkflowStore;onClose:()=>void;disabled:boolean;onSettings:()=>void;onEdit?:(flow:Workflow)=>void;onEnter:()=>void}){
 const {t}=useLocale(),state=useWorkflowStore(store),[tab,setTab]=useState('settings'),presets=rolePresetsForWorkflow(state.library.presets,(state.workflow||flow).id)
 const patch=(next:Partial<WorkflowNode>)=>{const updated={...node,...next};const ports=new Set(nodePorts(updated).map(p=>p.id));(onEdit||store.edit.bind(store))({...flow,nodes:flow.nodes.map(n=>n.id===node.id?updated:n),edges:['if','classifier','human'].includes(node.kind)?flow.edges.filter(e=>e.source!==node.id||ports.has(e.port||'default')):flow.edges})}
 const config=(next:Partial<WorkflowNode['config']>)=>patch({config:{...node.config,...next}})
 const preset=presets.find(p=>p.id===node.config.rolePresetId)
 const last=state.run?.executions.filter(e=>e.nodeId===node.id).at(-1),root=state.workflow||flow,variables=availableNodes(root,state.scopePath,node.id)
 const parents=allNodes(root).filter(n=>state.scopePath.includes(n.id))
 const rootInputs=root.nodes.filter(n=>n.kind==='input').flatMap(n=>n.config.fields||[])
 return <aside className="vdw-config" aria-label={t("节点配置")}>
 <header className="vdw-config-heading"><NodeBadge kind={node.kind}/><div className="vdw-config-title"><small>{displayNodeNumber(node.number)} · {t(NODE_LABELS[node.kind])}</small><input className="vdw-node-name" aria-label={t("节点名称")} title={node.title} value={node.title} maxLength={200} disabled={disabled} onChange={e=>patch({title:e.target.value})}/></div><div className="vdw-config-actions"><Tooltip side="bottom" maxWidth={300} label={node.fixed?t("取消固定节点"):t("固定节点，保护它不被 Agent 自动修改")} portal><Button size="sm" className="vdw-icon-button" aria-label={t("固定节点")} aria-pressed={node.fixed} disabled={disabled} onClick={()=>patch({fixed:!node.fixed})}><Glyph name="lock" size={16}/></Button></Tooltip><HelpButton label={t("节点")} text={definition(node.kind).description}><Glyph name="info" size={16}/></HelpButton><Button size="sm" className="vdw-icon-button" aria-label={t("关闭节点配置")} onClick={onClose}><Glyph name="close" size={16}/></Button></div></header>
 <p className="vdw-node-description">{definition(node.kind).description}</p><div className="vdw-config-tabs" role="tablist"><button role="tab" aria-selected={tab==='settings'} onClick={()=>setTab('settings')}>{t("设置")}</button><button role="tab" aria-selected={tab==='last'} onClick={()=>setTab('last')}>{t("上次运行")}</button></div>
 <div className="vdw-config-body">{tab==='last'?last?<ExecutionDetails execution={last}/>:<div className="vdw-empty"><p>{t("此节点还没有运行记录")}</p></div>:<>
 <PromptEditor label={t("备注")} help={t("节点备注，仅作说明，不影响执行；可省略")} placeholder={t("添加节点备注（可选）")} rows={3} maxLength={2000} value={node.note??''} disabled={disabled} onChange={note=>patch({note:note||undefined})}/>
 {(isModelNode(node.kind)||(node.kind==='document'&&node.config.documentMode==='agent'))&&<>
 <ModelSettings config={node.config} models={state.models} modelsError={state.modelsError} disabled={disabled} onChange={config}/>
 {node.kind==='agent'?<SubagentCard flow={root} node={node} presets={presets} sessionId={state.sessionId} disabled={disabled} onChange={update=>{const current=structuredClone(store.getSnapshot().workflow||flow);update(current);store.edit(current)}} onSettings={onSettings}/>:<> <Field label={t("角色预设")} help={t("预设只包含角色提示词。在高级设置的智能体预设中管理，后续运行采用最新内容。")}><Select label={t("选择角色预设")} value={node.config.rolePresetId||''} disabled={disabled} options={[{id:'',label:t("不使用角色预设")},...presets.map(p=>({id:p.id,label:p.name})),...(node.config.rolePresetId&&!preset?[{id:node.config.rolePresetId,label:`${node.config.rolePresetId}（缺少角色预设）`}]:[])]} onChange={id=>{if(id&&!presets.some(preset=>preset.id===id))return;config({rolePresetId:id||undefined})}}/>{node.config.rolePresetId&&!preset&&<small className="vdw-error">{t("原角色预设不可用，请选择现有预设，或明确选择“不使用角色预设”。")}</small>}</Field>
 {preset&&<PromptEditor role="SYSTEM" label={t("角色提示词")} value={preset.prompt} readOnly disabled={disabled} rows={4} help={t("由所选角色预设提供，在高级设置中修改；节点不会保存独立副本。")}/>}</>}
 </>}
 <SpecificConfig node={node} flow={flow} store={store} disabled={disabled} config={config} onEnter={onEnter}/>
 {node.kind!=='input'&&<VariableBrowser inputs={rootInputs} nodes={variables} parents={parents} executions={state.run?.executions||[]} environmentVariables={root.environmentVariables} includeSystem/>}

 {disabled&&<p className="vdw-muted">{t("当前运行使用已保存的版本。请先停止运行，再编辑原流程。")}</p>}
 </>}</div></aside>
}
/** Content-only section: Harness owns settings navigation, the outer modal and scrolling. */
export function WorkflowSettingsSection({store}:{store:WorkflowStore}){
  const {t,locale,setLocale}=useLocale()
  return <section className="vdw-settings-section vdw-workflow-preferences" aria-label={t('工作流设置')}>
    <style>{workflowSettingsStyles}</style>
    <div className="vdw-preference-row"><div><strong>{t('界面语言')}</strong><p>{t('仅改变工作流界面语言，流程名称、提示词和输入内容保持原文。','Change the workflow interface language. Workflow names, prompts and entered content keep their original text.')}</p></div><Select label={t('界面语言')} value={locale} options={[{id:'zh-CN',label:t("中文")},{id:'en',label:'English'}]} onChange={value=>setLocale(value as 'zh-CN'|'en')}/></div>
    <SaveSettings/>
    <HttpCacheSettings store={store}/>
    <p className="vdw-preferences-hint">{t('修改立即生效。界面语言和保存设置保存在当前浏览器；HTTP 响应缓存设置保存在本机工作流数据中。','Changes apply immediately. Language and save preferences are stored in this browser; HTTP response cache settings are stored in local workflow data.')}</p>
  </section>
}

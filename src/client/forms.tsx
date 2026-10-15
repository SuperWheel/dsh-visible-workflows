import { useEffect, useState } from 'react'
import { Button, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, NODE_LABELS, type RolePreset, type Workflow, type WorkflowNode } from '../shared/types.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { Glyph } from './icons.tsx'
import { Field, HelpButton, Select } from './controls.tsx'
import { PromptEditor } from './prompt-editor.tsx'
import { SpecificConfig } from './node-config.tsx'
import { allNodes, availableNodes, definition, isModelNode, nodePorts } from './nodes.ts'
import { NodeBadge } from './node-picker.tsx'
import { ModelSettings } from './model-settings.tsx'
import { VariableBrowser } from './variable-browser.tsx'
export { Field, Select } from './controls.tsx'
export function NodePanel({node,flow,store,onClose,disabled,onSettings,onEdit,onEnter}:{node:WorkflowNode;flow:Workflow;store:WorkflowStore;onClose:()=>void;disabled:boolean;onSettings:()=>void;onEdit?:(flow:Workflow)=>void;onEnter:()=>void}){
 const state=useWorkflowStore(store),[tab,setTab]=useState('settings')
 const patch=(next:Partial<WorkflowNode>)=>{const updated={...node,...next};const ports=new Set(nodePorts(updated).map(p=>p.id));(onEdit||store.edit.bind(store))({...flow,nodes:flow.nodes.map(n=>n.id===node.id?updated:n),edges:['if','classifier','human'].includes(node.kind)?flow.edges.filter(e=>e.source!==node.id||ports.has(e.port||'default')):flow.edges})}
 const config=(next:Partial<WorkflowNode['config']>)=>patch({config:{...node.config,...next}})
 const preset=state.library.presets.find(p=>p.id===node.config.rolePresetId)
 const last=state.run?.executions.filter(e=>e.nodeId===node.id).at(-1),root=state.workflow||flow,variables=availableNodes(root,state.scopePath,node.id)
 const parents=allNodes(root).filter(n=>state.scopePath.includes(n.id))
 const rootInputs=root.nodes.filter(n=>n.kind==='input').flatMap(n=>n.config.fields||[])
 return <aside className="vdw-config" aria-label="节点配置">
 <header className="vdw-config-heading"><NodeBadge kind={node.kind}/><div className="vdw-config-title"><small>{node.number} · {NODE_LABELS[node.kind]}</small><input className="vdw-node-name" aria-label="节点名称" title={node.title} value={node.title} maxLength={200} disabled={disabled} onChange={e=>patch({title:e.target.value})}/></div><div className="vdw-config-actions"><Tooltip label={node.fixed?"取消固定节点":"固定节点，保护它不被 Agent 自动修改"} portal><Button size="sm" className="vdw-icon-button" aria-label="固定节点" aria-pressed={node.fixed} disabled={disabled} onClick={()=>patch({fixed:!node.fixed})}><Glyph name="lock" size={16}/></Button></Tooltip><HelpButton label="节点" text={definition(node.kind).description}><Glyph name="info" size={16}/></HelpButton><Button size="sm" className="vdw-icon-button" aria-label="关闭节点配置" onClick={onClose}><Glyph name="close" size={16}/></Button></div></header>
 <p className="vdw-node-description">{definition(node.kind).description}</p><div className="vdw-config-tabs" role="tablist"><button role="tab" aria-selected={tab==='settings'} onClick={()=>setTab('settings')}>设置</button><button role="tab" aria-selected={tab==='last'} onClick={()=>setTab('last')}>上次运行</button></div>
 <div className="vdw-config-body">{tab==='last'?last?<><Field label="状态"><span>{last.status}</span></Field><Field label="输入"><pre>{last.input||'—'}</pre></Field><Field label="输出"><pre>{last.output||'—'}</pre></Field>{last.data&&<Field label="结构化输出"><pre>{JSON.stringify(last.data,null,2)}</pre></Field>}{last.error&&<p className="vdw-error">{last.error}</p>}</>:<div className="vdw-empty"><p>此节点还没有运行记录</p></div>:<>
 {(isModelNode(node.kind)||(node.kind==='document'&&node.config.documentMode==='agent'))&&<>
 <ModelSettings config={node.config} models={state.models} modelsError={state.modelsError} disabled={disabled} onChange={config}/>
 <Field label="角色预设" help="预设只包含角色提示词。前往设置统一管理，后续运行采用最新内容。"><Select label="选择角色预设" value={node.config.rolePresetId||''} disabled={disabled} options={[{id:'',label:'不使用角色预设'},...state.library.presets.map(p=>({id:p.id,label:p.name}))]} onChange={id=>config({rolePresetId:id||undefined})}/><Button size="sm" className="vdw-preset-manage" onClick={onSettings}>管理角色预设</Button></Field>
 {preset&&<PromptEditor role="SYSTEM" label="角色提示词" value={preset.prompt} readOnly disabled={disabled} rows={4} help="由所选角色预设提供，仅在设置中修改；节点不会保存独立副本。"/>}
 </>}
 <SpecificConfig node={node} flow={flow} store={store} disabled={disabled} config={config} onEnter={onEnter}/>
 {node.kind!=='input'&&<VariableBrowser inputs={rootInputs} nodes={variables} parents={parents} executions={state.run?.executions||[]}/>}

 {disabled&&<p className="vdw-muted">当前运行使用已保存的版本。请先停止运行，再编辑原流程。</p>}
 </>}</div></aside>
}
/** Content-only section: Harness owns settings navigation, the outer modal and scrolling. */
export function WorkflowSettingsSection({store}:{store:WorkflowStore}){
  const state=useWorkflowStore(store),[search,setSearch]=useState(''),[edit,setEdit]=useState<RolePreset>(),[pending,setPending]=useState(false),[error,setError]=useState(''),[loadError,setLoadError]=useState('')
  useEffect(()=>{let active=true;void store.refreshPresets().catch(e=>{if(active)setLoadError(String(e))});return()=>{active=false}},[store])
  const beginEdit=(preset?:RolePreset)=>{setError('');setEdit(preset?structuredClone(preset):{id:newId(),name:'',prompt:'',revision:0})}
  const save=async()=>{if(!edit||!edit.name.trim()||!edit.prompt.trim())return;setPending(true);setError('');try{const presets=await store.api.savePreset(JSON.stringify({...edit,name:edit.name.trim()}));store.update({library:{...store.getSnapshot().library,presets}});setEdit(undefined)}catch(e){setError(String(e))}finally{setPending(false)}}
  const remove=async()=>{if(!edit)return;setPending(true);setError('');try{const presets=await store.api.deletePreset(edit.id);store.update({library:{...store.getSnapshot().library,presets}});setEdit(undefined)}catch(e){setError(String(e))}finally{setPending(false)}}
  const query=search.trim().toLocaleLowerCase(),presets=state.library.presets.filter(p=>p.name.toLocaleLowerCase().includes(query))
  return <section className="vdw-settings-section" aria-label="工作流设置">
    <header className="vdw-settings-heading"><h2>角色预设</h2><p className="vdw-muted">统一管理角色提示词。更新后，后续运行使用新提示词；正在运行的任务保持原快照。</p></header>
    <div className="vdw-settings-toolbar"><Input aria-label="搜索角色预设" placeholder="搜索角色预设" value={search} onChange={e=>setSearch(e.target.value)}/><Button variant="primary" icon={<Glyph name="plus"/>} onClick={()=>beginEdit()}>新增预设</Button></div>
    {loadError&&<p className="vdw-error vdw-settings-error" role="alert">预设读取失败：{loadError}<Button size="sm" onClick={()=>{setLoadError('');void store.refreshPresets().catch(e=>setLoadError(String(e)))}}>重试</Button></p>}
    <div className="vdw-role-grid">{presets.map(p=><button type="button" key={p.id} className="vdw-role-card" aria-label={`编辑预设：${p.name}`} onClick={()=>beginEdit(p)}><strong>{p.name}</strong><p>{p.prompt}</p></button>)}</div>
    {!state.library.presets.length?<div className="vdw-empty"><p>还没有角色预设</p><small>添加角色提示词，随后在节点的下拉框中选择。</small><Button variant="outline" onClick={()=>beginEdit()}>新增角色预设</Button></div>:!presets.length&&<div className="vdw-empty"><p>没有匹配的预设</p><Button onClick={()=>setSearch('')}>清除搜索</Button></div>}
    {edit&&<Modal open title={edit.revision?'编辑角色预设':'新增角色预设'} closeLabel="关闭预设编辑" onClose={()=>!pending&&setEdit(undefined)} className="vdw-modal vdw-preset-modal" footer={<><Button disabled={pending} onClick={()=>setEdit(undefined)}>取消</Button><Button variant="primary" disabled={pending||!edit.name.trim()||!edit.prompt.trim()} onClick={()=>void save()}>{pending?'保存中…':'保存'}</Button></>}><Field label="名称"><Input data-modal-autofocus aria-label="预设名称" value={edit.name} disabled={pending} onChange={e=>setEdit({...edit,name:e.target.value})}/></Field><Field label="角色提示词"><textarea aria-label="角色提示词" rows={9} value={edit.prompt} disabled={pending} onChange={e=>setEdit({...edit,prompt:e.target.value})}/></Field>{error&&<p className="vdw-error" role="alert">{error}</p>}{!!edit.revision&&<Button disabled={pending} onClick={()=>void remove()}>删除预设</Button>}</Modal>}
  </section>
}

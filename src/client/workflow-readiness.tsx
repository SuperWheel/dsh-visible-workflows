import { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow, WorkflowNode } from '../shared/types.ts'
import type { WorkflowReadinessIssue } from '../shared/workflow-import.ts'
import { Glyph } from './icons.tsx'
import { t, useLocale } from './i18n.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'

/** Translate structured Host diagnostics without changing identifiers or user-authored content. */
export function readinessMessage(issue:WorkflowReadinessIssue):string {
  const message=issue.message
  const known:Record<string,string>={
    '节点未连接到用户输入入口':'This node is not connected to a user input entry',
    '原思考强度在当前模型不可用，请重新选择':'The selected reasoning effort is unavailable. Choose another effort.',
    'DSH 默认思考强度在当前模型不可用，请在 DSH 或此节点重新选择':'The DSH default reasoning effort is unavailable. Update DSH or this node.',
    '未指定模型，DSH 也未配置默认模型；请在 DSH 选择模型或为此节点指定模型':'No model is selected and DSH has no default. Select a model in DSH or in this node.',
    '请选择知识来源文件':'Select a knowledge source file',
    '子工作流递归调用或超过 8 层限制':'Recursive workflow call or more than 8 nested workflows',
    '包含人工介入的子工作流须独立运行，请选择其他流程':'Workflows with human intervention must run independently. Choose another workflow.',
  }
  if(known[message])return t(message,known[message])
  if(issue.kind==='model'&&issue.dependencyId&&message===`模型 ${issue.dependencyId} 在当前宿主不可用，请重新选择或配置`)return t('模型 {model} 在当前宿主不可用，请重新选择或配置','Model {model} is unavailable in this host. Select or configure a model.',{model:issue.dependencyId})
  if(issue.kind==='role'&&issue.dependencyId&&message===`角色预设 ${issue.dependencyId} 不存在或不属于当前工作流，请选择角色或取消此引用`)return t('角色预设 {id} 不存在或不属于当前工作流，请选择角色或取消此引用','Role preset {id} is missing or belongs to another workflow. Choose a role or clear the reference.',{id:issue.dependencyId})
  return message
}
export function MissingValueTriangle(){
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="vdw-missing-triangle"><path d="M7.05 1.7a1.1 1.1 0 0 1 1.9 0l6.2 10.9a1.1 1.1 0 0 1-.95 1.65H1.8a1.1 1.1 0 0 1-.95-1.65Z" fill="currentColor"/><path d="M8 5v4" stroke="white" strokeWidth="1.6" strokeLinecap="round"/><circle cx="8" cy="11.4" r=".9" fill="white"/></svg>
}
/** A container also carries a warning when an unopened child needs attention. */
export function issuesForNode(node:WorkflowNode,issues:WorkflowReadinessIssue[]):WorkflowReadinessIssue[]{
  const ids=new Set<string>();const visit=(value:WorkflowNode)=>{ids.add(value.id);value.config.body?.nodes.forEach(visit)};visit(node)
  return issues.filter(issue=>issue.nodeId&&ids.has(issue.nodeId))
}
export function NodeReadinessWarning({node,issues,onConfigure}:{node:WorkflowNode;issues:WorkflowReadinessIssue[];onConfigure:()=>void}){
  const {t}=useLocale()
  const found=issuesForNode(node,issues)
  if(!found.length)return null
  return <Tooltip label={found.map(readinessMessage).join('；')} portal side="bottom" maxWidth={300}><button className="vdw-node-missing" aria-label={t('{name}：{count} 项待处理配置','{name}: {count} configuration issues',{name:node.title,count:found.length})} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onConfigure()}}><MissingValueTriangle/></button></Tooltip>
}
export function nodeScopePath(flow:Workflow,id:string):string[]|undefined{
  const find=(nodes:WorkflowNode[],path:string[]):string[]|undefined=>{for(const node of nodes){if(node.id===id)return path;const found=node.config.body&&find(node.config.body.nodes,[...path,node.id]);if(found)return found}return undefined}
  return find(flow.nodes,[])
}
export function WorkflowReadinessNotice({store,onLocate}:{store:WorkflowStore;onLocate:(issue:WorkflowReadinessIssue)=>void}){
  const {t}=useLocale()
  const state=useWorkflowStore(store),[expanded,setExpanded]=useState(true),issues=state.readiness?.issues??[]
  const panel=useRef<HTMLElement>(null)
  useEffect(()=>{if(state.readinessFocus){setExpanded(true);panel.current?.focus({preventScroll:true})}},[state.readinessFocus])
  if(!issues.length&&state.readinessState!=='error')return null
  const checking=state.readinessState==='checking',failed=state.readinessState==='error'
  return <section ref={panel} tabIndex={-1} className="vdw-readiness-panel" aria-label={t('工作流待处理配置','Workflow configuration issues')} aria-busy={checking}>
    <header><button className="vdw-readiness-toggle" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}><MissingValueTriangle/><strong>{issues.length?t('{count} 项待处理','{count} issues to resolve',{count:issues.length}):t('配置检查未完成','Configuration check incomplete')}</strong><Glyph name={expanded?'chevron-up':'chevron-down'} size={14}/></button><Button size="sm" disabled={checking} aria-label={t('重新检查工作流配置','Recheck workflow configuration')} onClick={()=>void store.save().catch(()=>{})}><Glyph name="loop" size={14}/></Button></header>
    {expanded&&<div className="vdw-readiness-content">
      {failed&&<p role="alert" className="vdw-error">{state.readinessError||t('检查失败，请重新检查。','Check failed. Please try again.')}</p>}
      {!!issues.length&&<ol>{issues.map(issue=><li key={issue.id}><button onClick={()=>onLocate(issue)}><span>{readinessMessage(issue)}</span><small>{issue.action==='environment'?t('配置环境变量','Configure environment'):issue.nodeId?t('定位并配置节点','Locate and configure node'):t('查看配置','View configuration')}</small><Glyph name="chevron-right" size={14}/></button></li>)}</ol>}
    </div>}
  </section>
}

export const workflowReadinessStyles=`
.vdw-missing-triangle { display:block; flex:none; color:var(--dsw-alias-state-error-primary,#dc3545); }
.vdw-node-title > .vdw-node-missing { display:flex; flex:none; align-items:center; justify-content:center; width:20px; height:24px; padding:2px; border:0; background:transparent; border-radius:4px; cursor:pointer; }
.vdw-node-title:has(.vdw-node-missing) > strong { flex:0 1 auto; }
.vdw-node-missing:hover { background:var(--dsw-alias-interactive-bg-hover); }
.vdw-editor-dock { position:absolute; right:12px; top:var(--vdw-inspector-top,60px); bottom:12px; width:min(360px,calc(100% - 24px)); min-height:0; display:flex; flex-direction:column; gap:8px; z-index:6; pointer-events:none; }
.vdw-editor-dock > :is(.vdw-config,.vdw-run-panel,.vdw-variable-panel) { position:relative; inset:auto; width:100%; flex:1; min-height:140px; pointer-events:auto; }
.vdw-readiness-panel { display:flex; flex-direction:column; flex:0 1 auto; min-height:46px; max-height:100%; overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-base); box-shadow:var(--dsw-elevation-soft); pointer-events:auto; }
.vdw-editor-dock.has-details > .vdw-readiness-panel,.vdw-editor-dock.has-details > .vdw-editor-notices { max-height:36%; }
.vdw-editor-notices { display:flex; flex-direction:column; gap:8px; flex:0 1 auto; min-height:0; max-height:100%; overflow:auto; overscroll-behavior:contain; pointer-events:auto; }
.vdw-editor-notices > .vdw-readiness-panel { flex:none; max-height:none; }
.vdw-readiness-panel > header { display:flex; flex:none; align-items:center; padding:6px 8px; gap:4px; min-height:42px; }
.vdw-readiness-toggle { display:flex; flex:1; min-width:0; align-items:center; gap:8px; padding:4px; background:none; border:0; color:inherit; text-align:left; cursor:pointer; }
.vdw-readiness-toggle > strong { flex:1; font-size:13px; line-height:20px; }
.vdw-readiness-content { min-height:0; overflow:auto; padding:0 12px 12px; }
.vdw-readiness-content > p { margin:0 0 8px; font-size:12px; line-height:18px; }
.vdw-readiness-content ol { list-style:none; padding:0; margin:0; }
.vdw-readiness-content li + li { border-top:1px solid var(--dsw-alias-border-l2); }
.vdw-readiness-content li > button { display:grid; grid-template-columns:minmax(0,1fr) 16px; gap:4px 8px; width:100%; padding:9px 0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
.vdw-readiness-content li > button:hover { color:var(--vdw-accent); }
.vdw-readiness-content li span { font-size:12px; line-height:18px; overflow-wrap:anywhere; }
.vdw-readiness-content li small { grid-column:1; color:var(--vdw-accent); font-size:12px; }
.vdw-readiness-content li svg { grid-column:2; grid-row:1 / span 2; align-self:center; }
.vdw-missing-tool > span { min-width:0; flex:1; overflow-wrap:anywhere; }
.vdw-missing-tool strong,.vdw-missing-tool small { display:block; font-size:12px; line-height:18px; }
.vdw-editor-body:has(> .vdw-canvas-wrap.is-inspector-compact) > .vdw-editor-dock { bottom:56px; }
`

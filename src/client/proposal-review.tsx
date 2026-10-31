import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Workflow } from '../shared/types.ts'
import { allNodes } from './nodes.ts'
import { DataViewer } from './data-viewer.tsx'
import { Glyph } from './icons.tsx'
import { proposalReviewStyles } from './proposal-review-style.ts'
import { useWorkflowStore, type WorkflowStore } from './store.ts'

export function workflowChangeSummary(before:Workflow,after:Workflow) {
  const old=allNodes(before),next=allNodes(after),oldMap=new Map(old.map(node=>[node.id,node])),nextMap=new Map(next.map(node=>[node.id,node]))
  return {added:next.filter(node=>!oldMap.has(node.id)),removed:old.filter(node=>!nextMap.has(node.id)),changed:next.filter(node=>oldMap.has(node.id)&&JSON.stringify(node)!==JSON.stringify(oldMap.get(node.id))).map(node=>({before:oldMap.get(node.id)!,after:node})),edgesChanged:JSON.stringify(before.edges)!==JSON.stringify(after.edges),variablesChanged:JSON.stringify(before.environmentVariables)!==JSON.stringify(after.environmentVariables),policyChanged:JSON.stringify(before.executionPolicy)!==JSON.stringify(after.executionPolicy)}
}
export function ProposalReview({store,onClose}:{store:WorkflowStore;onClose:()=>void}) {
  const state=useWorkflowStore(store),flow=state.workflow!,pending=state.proposals?.filter(proposal=>proposal.status==='pending')??[],[selected,setSelected]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false)
  const proposal=pending.find(item=>item.id===selected)??pending[0],changes=proposal?workflowChangeSummary(flow,proposal.candidate):undefined,conflict=proposal?.baseRevision!==flow.revision&&proposal?.canAcceptAtRevision!==flow.revision
  const resolve=async(action:'accept'|'reject')=>{if(!proposal||working)return;setError('');setWorking(true);try{await store.resolveProposal(proposal.id,action);onClose()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setWorking(false)}}
  return <Modal open headless title="查看修改提案" className="vdw-modal vdw-proposal-review" onClose={()=>!working&&onClose()}>
    <style>{proposalReviewStyles}</style>
    <header className="vdw-proposal-review-heading"><h2>查看修改提案</h2><Button type="button" size="sm" className="vdw-proposal-review-close" aria-label="关闭修改提案" disabled={working} onClick={onClose}><Glyph name="close"/></Button></header>
    <div className="vdw-proposal-review-body" aria-busy={working}>
    {!proposal?<p>暂无待接受的修改提案。</p>:<>
      {pending.length>1&&<div className="vdw-proposal-review-tabs">{pending.map((item,index)=><Button size="sm" key={item.id} aria-pressed={proposal.id===item.id} onClick={()=>{setSelected(item.id);setError('')}}>提案 {index+1}</Button>)}</div>}
      <div className="vdw-proposal-review-intro"><p>{proposal.summary||'Agent 提交了工作流修改。接受后将校验固定节点、引用、类型及版本，再保存新定义。'}</p>
      <p className="vdw-muted">提案基础 v{proposal.baseRevision} · 当前 v{flow.revision} · {new Date(proposal.createdAt).toLocaleString('zh-CN')}</p></div>
      {conflict&&<p className="vdw-error" role="alert">原流程已变化，当前提案无法直接接受。请让 Agent 基于最新版本重新生成；本提案会保留。</p>}
      <div className="vdw-json-summary"><strong>影响范围</strong><p>新增 {changes!.added.length} 个节点 · 修改 {changes!.changed.length} 个节点 · 删除 {changes!.removed.length} 个节点</p><p>{[changes!.edgesChanged?'主图连线变化':null,changes!.variablesChanged?'环境变量变化':null,changes!.policyChanged?'执行策略变化':null].filter(Boolean).join(' · ')||'主图连线、环境变量和执行策略未变化'}</p></div>
      {!!(changes!.added.length+changes!.removed.length+changes!.changed.length)&&<div className="vdw-proposal-review-stack">
        {changes!.added.map(node=><DataViewer key={`add-${node.id}`} title={`新增：${node.number} ${node.title}`} value={node}/>)}
        {changes!.removed.map(node=><DataViewer key={`remove-${node.id}`} title={`删除：${node.number} ${node.title}`} value={node}/>)}
        {changes!.changed.map(change=><section key={change.after.id} className="vdw-proposal-change"><h3>{change.after.number} · {change.after.title}</h3><div className="vdw-proposal-review-stack"><DataViewer title="修改前" value={change.before}/><DataViewer title="修改后" value={change.after}/></div></section>)}
      </div>}
      <details className="vdw-proposal-review-definitions"><summary>查看完整定义差异</summary><div className="vdw-proposal-review-stack"><DataViewer title="当前定义" value={flow}/><DataViewer title="提议定义" value={proposal.candidate}/></div></details>
      <p className="vdw-muted">修改不改变正在运行的快照。Secret 的值与授权不能通过提案写入。</p>
    </>}{error&&<p className="vdw-error" role="alert">{error}</p>}
    </div>
    <footer className="vdw-proposal-review-footer">{proposal?<><Button variant="outline" size="sm" disabled={working} onClick={()=>void resolve('reject')}>拒绝修改</Button><Button variant="primary" size="sm" disabled={working||conflict} onClick={()=>void resolve('accept')}>接受并应用</Button></>:<Button size="sm" onClick={onClose}>关闭</Button>}</footer>
  </Modal>
}

import type { LibrarySnapshot, Workflow } from '../shared/types.ts'
import { allNodes } from '../shared/workflow-validation.ts'

export function archiveImpact(flow:Workflow,library:LibrarySnapshot){
  const references=library.workflows.filter(other=>other.id!==flow.id&&allNodes(other).some(node=>[node.config.toolId,...(node.config.tools??[])].includes(`workflow:${flow.id}`)))
  const runs=library.runs.filter(run=>run.workflowId===flow.id)
  const active=runs.filter(run=>['running','waiting','paused','pausing','budget_waiting'].includes(run.status))
  return {references,runs,active}
}
export function ArchiveImpact({flow,library}:{flow:Workflow;library:LibrarySnapshot}){
  const impact=archiveImpact(flow,library)
  return <div aria-label="归档影响"><p>{impact.runs.length} 条运行记录会保留；已有运行快照不变。</p>{impact.references.length?<><p>以下流程引用了它；归档后，这些流程的新运行需要先替换引用或恢复该流程：</p><ul>{impact.references.map(item=><li key={item.id}>{item.title}</li>)}</ul></>:<p>没有其他流程引用此工作流。</p>}{!!impact.active.length&&<p role="alert">有 {impact.active.length} 条未结束运行，请先取消后再归档。</p>}</div>
}

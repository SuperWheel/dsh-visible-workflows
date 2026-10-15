import { useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputField, NodeExecution, WorkflowNode } from '../shared/types.ts'
import { Glyph } from './icons.tsx'
import { inputVariable, nodeOutputVariables, scopeVariables, type VariableMetadata } from './variable-metadata.ts'

function VariableRow({variable}:{variable:VariableMetadata}) {
 const [feedback,setFeedback]=useState(''),[failed,setFailed]=useState(false)
 const copy=async()=>{try{await navigator.clipboard.writeText(variable.reference);setFailed(false);setFeedback('已复制')}catch{setFailed(true);setFeedback('复制失败，请选择下方引用后复制')}}
 return <li className="vdw-variable-row">
  <div className="vdw-variable-heading"><code title={variable.reference}>{variable.name}</code><span className="vdw-variable-type">{variable.type}</span><Tooltip label={`复制 ${variable.reference}`} portal><Button size="sm" className="vdw-variable-copy vdw-icon-button" aria-label={`复制引用 ${variable.reference}`} onClick={()=>void copy()}><Glyph name="copy" size={14}/></Button></Tooltip></div>
  <p className="vdw-variable-description">{variable.description}</p>
  {feedback&&<small role="status" className="vdw-variable-status">{feedback}</small>}{failed&&<code className="vdw-variable-reference">{variable.reference}</code>}
 </li>
}
function VariableGroup({title,variables}:{title:string;variables:VariableMetadata[]}) {
 return <section className="vdw-variable-group"><h4 className="vdw-variable-group-title">{title}</h4>{variables.length?<ul className="vdw-variable-list">{variables.map(variable=><VariableRow key={variable.reference} variable={variable}/>)}</ul>:<p className="vdw-variable-description">尚无已声明或已运行的输出字段，请先运行并查看真实输出。</p>}</section>
}
export function VariableBrowser({inputs,nodes,parents,executions}:{inputs:InputField[];nodes:WorkflowNode[];parents:WorkflowNode[];executions:NodeExecution[]}) {
 const scope=scopeVariables(parents,nodes,executions)
 return <details className="vdw-variables"><summary>可引用的变量</summary>
  <p className="vdw-variable-intro">仅显示当前层及外层已连接的上游变量。未执行的分支可能没有输出；提取参数仅在成功后可用。</p>
  {!!inputs.length&&<VariableGroup title="工作流输入" variables={inputs.map(field=>inputVariable(field))}/>}
  {nodes.filter(node=>node.kind!=='input').map(node=><VariableGroup key={node.id} title={`${node.number} · ${node.title}`} variables={nodeOutputVariables(node,executions.filter(record=>record.nodeId===node.id&&record.status==='success').at(-1)?.data)}/>)}
  {!!scope.length&&<VariableGroup title="当前循环作用域" variables={scope}/>}
 </details>
}

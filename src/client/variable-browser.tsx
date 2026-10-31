import { t, useLocale } from './i18n.ts'
import { displayNodeNumber } from './annotation-nodes.ts'
import { useId, useState } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputField, NodeExecution, WorkflowNode, EnvironmentVariable } from '../shared/types.ts'
import { Glyph } from './icons.tsx'
import { inputVariable, nodeOutputVariables, scopeVariables, type VariableMetadata } from './variable-metadata.ts'
import { environmentMetadata, systemMetadata } from './workflow-variables.ts'

function VariableRow({variable}:{variable:VariableMetadata}) {useLocale();
 const fieldId=useId()
 const [feedback,setFeedback]=useState(''),[failed,setFailed]=useState(false)
 const copy=async()=>{try{await navigator.clipboard.writeText(variable.reference);setFailed(false);setFeedback('已复制')}catch{setFailed(true);setFeedback('复制失败，请选择下方引用后复制')}}
 return <li className="vdw-variable-row" aria-labelledby={`${fieldId}-name ${fieldId}-type`} aria-describedby={`${fieldId}-description`}>
  <div className="vdw-variable-heading"><code id={`${fieldId}-name`} title={variable.reference}>{variable.name}</code><span id={`${fieldId}-type`} className="vdw-variable-type">{variable.type}</span><Tooltip side="bottom" maxWidth={300} label={t('复制 {reference}','Copy {reference}',{reference:variable.reference})} portal><Button type="button" size="sm" className="vdw-variable-copy vdw-icon-button" aria-label={t('复制引用 {reference}','Copy reference {reference}',{reference:variable.reference})} onClick={()=>void copy()}><Glyph name="copy" size={14}/></Button></Tooltip></div>
  <p id={`${fieldId}-description`} className="vdw-variable-description">{variable.description}</p>
  {feedback&&<small role="status" className="vdw-variable-status">{t(feedback)}</small>}{failed&&<code className="vdw-variable-reference">{variable.reference}</code>}
 </li>
}
function VariableGroup({title,variables}:{title:string;variables:VariableMetadata[]}) {useLocale();
 const titleId=useId()
 return <section className="vdw-variable-card" aria-labelledby={titleId}><header className="vdw-variable-toolbar"><h4 id={titleId}>{title}</h4><span className="vdw-variable-count">{variables.length} {t("个字段")}</span></header><div className="vdw-variable-content">{variables.length?<ul className="vdw-variable-list" aria-label={t('{title}的可引用字段','References from {title}',{title})}>{variables.map(variable=><VariableRow key={variable.reference} variable={variable}/>)}</ul>:<p className="vdw-variable-empty">{t("尚无已声明或已运行的输出字段，请先运行并查看真实输出。")}</p>}</div></section>
}
export function VariableBrowser({inputs,nodes,parents,executions,environmentVariables,includeSystem=false}:{inputs:InputField[];nodes:WorkflowNode[];parents:WorkflowNode[];executions:NodeExecution[];environmentVariables?:EnvironmentVariable[];includeSystem?:boolean}) {useLocale();
 const scope=scopeVariables(parents,nodes,executions),sources=nodes.filter(node=>node.kind!=='input')
 return <details className="vdw-variables"><summary>{t("可引用的变量")}</summary>
  <p className="vdw-variable-intro">{t("节点输出仅显示已连接的上游变量。环境和系统变量无需连线；Secret 不可作为普通变量使用。")}</p>
  <div className="vdw-variable-cards">
  {!!inputs.length&&<VariableGroup title={t("工作流输入")} variables={inputs.map(field=>inputVariable(field))}/>}
  {sources.map(node=><VariableGroup key={node.id} title={`${displayNodeNumber(node.number)} · ${node.title}`} variables={nodeOutputVariables(node,executions.filter(record=>record.nodeId===node.id&&record.status==='success').at(-1)?.data)}/>)}
  {!!scope.length&&<VariableGroup title={t("当前循环作用域")} variables={scope}/>}
  {!!environmentVariables?.some(variable=>variable.type!=='secret')&&<VariableGroup title={t("环境变量")} variables={environmentMetadata(environmentVariables)}/>}
  {includeSystem&&<VariableGroup title={t("系统变量")} variables={systemMetadata().map(variable=>({...variable,description:t(variable.description)}))}/>}
  {!inputs.length&&!sources.length&&!scope.length&&!environmentVariables?.length&&!includeSystem&&<p className="vdw-variable-empty">{t("当前没有可引用的变量。请先声明输入字段或连接上游节点。")}</p>}
  </div>
 </details>
}

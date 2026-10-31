import type { Condition, ConditionOperator, WorkflowNode } from '../shared/types.ts'
import { branchTop, nodePorts } from './nodes.ts'

const operators: Record<ConditionOperator, string> = {
  equals: '=', not_equals: '≠', contains: '包含', not_contains: '不包含',
  starts_with: '开头为', ends_with: '结尾为', gt: '>', gte: '≥', lt: '<', lte: '≤',
  empty: '为空', not_empty: '不为空',
}

function conditionText(condition: Condition): string {
  const variable = condition.variable || '未设置变量', operator = operators[condition.operator] || condition.operator
  if (condition.operator === 'empty' || condition.operator === 'not_empty') return `${variable} ${operator}`
  return `${variable} ${operator} ${condition.value === undefined ? '未设置比较值' : condition.value === '' ? '""' : condition.value}`
}

function summaryFor(node: WorkflowNode, portId: string): string | undefined {
  if (node.kind === 'if') {
    if(node.config.logicGate)return `${node.config.logicGate.operator} 判定为 ${portId==='true'?'true':'false'}`
    if (portId === 'false') return '其他情况'
    const branch = node.config.cases?.find(value => value.id === portId)
    if (branch) return branch.conditions.length ? branch.conditions.map(conditionText).join(branch.logic === 'or' ? ' 或 ' : ' 且 ') : '未设置条件'
    return conditionText({ variable: node.config.variable || '', operator: node.config.operator || 'not_empty', value: node.config.value })
  }
  if (node.kind === 'classifier') return node.config.classes?.find(value => value.id === portId)?.description?.trim() || undefined
  if (node.kind === 'human') {
    if (portId === 'default') return '任一常规行动后'
    if (portId !== 'timeout') return '用户选择'
    const seconds = node.config.timeoutSeconds || 259200
    if (!Number.isFinite(seconds) || seconds <= 0) return '等待响应超时'
    const [amount, unit] = seconds % 86400 === 0 ? [seconds / 86400, '天'] : seconds % 3600 === 0 ? [seconds / 3600, '小时'] : seconds % 60 === 0 ? [seconds / 60, '分钟'] : [seconds, '秒']
    return `${amount} ${unit}未响应`
  }
  return undefined
}

/** Presentation only. Each 32px slot stays aligned with the unchanged source port. */
export function NodeBranches({node}: {node: WorkflowNode}) {
  if (!['if', 'classifier', 'human'].includes(node.kind)) return null
  return <div className="vdw-node-branches" data-kind={node.kind} role="list" aria-label="分支出口" style={{top: branchTop(node)}}>
    {nodePorts(node).map(port => {
      const label = port.label || (node.kind === 'classifier' ? '未命名分类' : '未命名操作'), summary = summaryFor(node, port.id)
      return <div key={port.id} className="vdw-node-branch-row" data-port-id={port.id} role="listitem" title={summary ? `${label} · ${summary}` : label}>
        <div className={`vdw-node-branch-content${summary ? ' has-summary' : ''}`}>{summary && <span className="vdw-node-branch-summary">{summary}</span>}<span className="vdw-node-branch-label">{label}</span></div>
      </div>
    })}
  </div>
}

import type { NodeGraph, Workflow, WorkflowNode } from './types.ts'
import type { PlanningContext, PlanningIssue } from './planning-types.ts'
import { allNodes, parseWorkflow } from './workflow-validation.ts'
import { pointer } from './planning-repair.ts'

/** Planning-only guard for the fields executeNode actually renders/resolves.
 * Literal code, input defaults, metadata and JSON iterator literals stay literal.
 * Storage/runtime validation deliberately retains compatibility with old graphs. */
export function planningTemplateSyntaxIssues(workflow: Workflow, context: PlanningContext): PlanningIssue[] {
  const baseline = new Map(allNodes(parseWorkflow(context.workflow)).map(n => [n.id, n]))
  const nodes = new Map(allNodes(workflow).map(n => [n.id, n]))
  const issues: PlanningIssue[] = []
  const definition = (n: WorkflowNode) => JSON.stringify({ kind: n.kind, config: { ...n.config, body: undefined } })
  const inspect = (node: WorkflowNode, value: unknown, path: (string | number)[], bare = false): void => {
    if (typeof value === 'string') {
      const expressions = [...value.matchAll(/\{\{([\s\S]*?)\}\}/g)].map(m => m[1]!.trim())
      const literal = value.replace(/\{\{[\s\S]*?\}\}/g, '')
      if (bare && !expressions.length) expressions.push(value.trim())
      const filtered = expressions.find(e => e.includes('|'))
      const syntax = filtered ? '过滤器' : /\{%[\s\S]*?%\}/.test(literal) ? 'for/if 等模板语句'
        : /\{#[\s\S]*?#\}/.test(literal) ? '模板注释'
        : expressions.some(e => !nodes.has(e) && /\s(?:and|or|in|is|[+*/<>!=~-])\s|^not\s|^["']|^-?\d+(?:\.\d+)?$|^(?:true|false|null)$|\[[^\d"']/.test(e)) ? '模板表达式' : undefined
      if (!syntax) return
      const producer = filtered?.split('|')[0]!.trim().split('.')
      const container = producer?.length === 2 && ['result', 'json'].includes(producer[1]!)
        && ['iteration', 'list'].includes(nodes.get(producer[0]!)?.kind ?? '') && filtered?.split('|').slice(1).join('|').trim() === 'tojson'
      const fix = container ? `容器结果用 {{${producer![0]}.text}}（已是 JSON 文本），或先接 template 节点做 ${filtered!.includes('tojson') ? 'tojson' : '格式化'}`
        : '先接 template 节点完成格式化，再用 {{格式化节点.text}} 引用'
      issues.push({ code: 'TEMPLATE_SYNTAX_UNSUPPORTED', nodeId: node.id, path: pointer(['config', ...path]),
        message: `${node.kind}.${path.join('.')} 不支持${syntax}；${fix}；此字段${bare ? '只读取路径' : '只支持普通 {{path}} 插值'}。` })
    } else if (Array.isArray(value)) value.forEach((item, i) => inspect(node, item, [...path, i]))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) inspect(node, item, [...path, key])
  }
  const visit = (graph: NodeGraph, changedParent = false): void => {
    for (const node of graph.nodes) {
      const old = baseline.get(node.id), c = node.config
      const affected = context.operation === 'create' || changedParent || !old || definition(node) !== definition(old) || context.targetNodeIds.includes(node.id)
      if (affected) {
        const field = (name: keyof typeof c, bare = false) => inspect(node, c[name], [name], bare)
        const condition = (value: { variable: string; value?: string } | undefined, path: (string | number)[]) => {
          if (value) { inspect(node, value.variable, [...path, 'variable'], true); inspect(node, value.value, [...path, 'value']) }
        }
        if (node.kind === 'output') field('text')
        if (['llm', 'agent', 'classifier', 'extractor', 'human'].includes(node.kind) || node.kind === 'document' && c.documentMode === 'agent') field('prompt')
        if (node.kind === 'human') c.fields?.forEach((f, i) => inspect(node, f.defaultValue, ['fields', i, 'defaultValue']))
        if (node.kind === 'knowledge') field('query')
        if (node.kind === 'http' && !c.credentialOperation) { field('url'); field('bodyText'); field('headers') }
        if (node.kind === 'document' && c.source?.includes('{{')) field('source')
        // These node kinds reach mapping(c.inputs) after the early-return branches.
        if (!['input', 'if', 'human', 'exit_loop', 'iteration', 'loop', 'aggregator', 'assigner', 'list'].includes(node.kind)) field('inputs')
        if (node.kind === 'if') {
          if (c.logicGate) c.logicGate.inputs.forEach((input, i) => inspect(node, input.value, ['logicGate', 'inputs', i, 'value']))
          else if (c.cases?.length) c.cases.forEach((branch, i) => branch.conditions.forEach((v, j) => condition(v, ['cases', i, 'conditions', j])))
          else { field('variable', true); field('value') }
        }
        if (node.kind === 'assigner') c.assignments?.forEach((a, i) => inspect(node, a.value, ['assignments', i, 'value']))
        if (node.kind === 'aggregator') c.groups?.forEach((g, i) => g.variables.forEach((v, j) => inspect(node, v, ['groups', i, 'variables', j], true)))
        if (node.kind === 'list' || node.kind === 'iteration') {
          const key = node.kind === 'list' ? 'listSource' : 'iterator'
          if (!c[key]?.trim().startsWith('[')) field(key, true)
          if (node.kind === 'list') condition(c.filter, ['filter'])
        }
        if (node.kind === 'loop') { field('initialVariables'); condition(c.until, ['until']) }
        if (c.body) field('outputVariable', true)
      }
      if (c.body) visit(c.body, affected)
    }
  }
  visit(workflow)
  return issues
}

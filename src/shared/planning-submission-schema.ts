import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { CompilerIssue } from './planning-repair.ts'

/** SDK oneOf requires at least two branches. A sole branch has identical
 * validation semantics without the union wrapper; never discard alternatives.
 */
export function planningOneOf(branches: readonly JsonSchemaNode[]): JsonSchemaNode {
  if (!branches.length) throw new Error('规划 Schema 的候选分支不能为空')
  return branches.length === 1 ? branches[0]! : { oneOf: [...branches] }
}

/** The SDK alone decides pass/fail. Diagnostic traversal follows discriminators
 * instead of multiplying every submission branch by every patch alternative. */
export function submissionSchemaIssues(schema: JsonSchemaNode, value: unknown): CompilerIssue[] {
  const violations = validateJsonSchemaValue(schema, value)
  if (!violations.length) return []
  const details = new Set<string>(), maximum = 8
  let visited = 0, listedPaths = false
  const add = (errors: readonly string[]) => { for (const error of errors) if (details.size < maximum) details.add(error) }
  const visit = (node: JsonSchemaNode, item: unknown, path: string): void => {
    if (++visited > 200 || details.size >= maximum) return
    const errors = validateJsonSchemaValue(node, item, path)
    if (!errors.length) return
    if (node.oneOf) {
      const valid = node.oneOf.filter(branch => !validateJsonSchemaValue(branch, item, path).length)
      // Preserve exact-oneOf overlap errors, even if a discriminator suggests
      // one branch. Expanding valid branches would hide the actual failure.
      if (valid.length > 1) { add(errors); return }
      const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined
      const discriminators = node.oneOf.every(branch => Object.hasOwn(branch.properties?.op ?? {}, 'const')) ? ['op', 'path'] :
        node.oneOf.some(branch => Object.hasOwn(branch.properties?.mode ?? {}, 'const')) ? ['mode'] : []
      if (record && discriminators.length) {
        const modeBranches = discriminators[0] === 'mode' ? node.oneOf.filter(branch => Object.hasOwn(record, 'mode') && branch.properties?.mode?.const === record.mode) : []
        const matching = (modeBranches.length ? modeBranches : node.oneOf).filter(branch => discriminators.every(key => {
          const field = branch.properties?.[key]
          return !Object.hasOwn(record, key) ? !branch.required?.includes(key) : !field || !validateJsonSchemaValue(field, record[key]).length
        }))
        if (matching.length) { matching.forEach(branch => visit(branch, item, path)); return }
        if (discriminators[0] === 'op') {
          const allowed = [...new Set(node.oneOf.flatMap(branch => typeof branch.properties?.path?.const === 'string' ? [branch.properties.path.const] : []))]
          add([`${path}: op/path pair ${JSON.stringify([record.op, record.path])} is not allowed` +
            (listedPaths ? '' : `; allowed paths: ${allowed.join(', ')}`)])
          listedPaths = true
        } else add([`${path}.mode: ${JSON.stringify(record.mode)} is not allowed; allowed modes: ${node.oneOf.map(branch => branch.properties?.mode?.const).filter(mode => mode !== undefined).join(', ')}`])
        return
      }
      // Undiscriminated unions: explain the closest branch without presenting
      // the required fields of all alternatives as simultaneous obligations.
      const closest = node.oneOf.map(branch => ({ branch, errors: validateJsonSchemaValue(branch, item, path) })).sort((a, b) => a.errors.length - b.errors.length)[0]
      if (closest) visit(closest.branch, item, path)
      return
    }
    if (node.type === 'object' && item && typeof item === 'object' && !Array.isArray(item)) {
      // Check this level's required/unknown keys separately from child errors.
      add(validateJsonSchemaValue({ ...node, properties: Object.fromEntries(Object.keys(node.properties ?? {}).map(key => [key, {}])) }, item, path))
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (Object.hasOwn(item, key)) visit(child, (item as Record<string, unknown>)[key], `${path}.${key}`)
      }
    } else if (node.type === 'array' && Array.isArray(item) && node.items) {
      item.forEach((entry, index) => visit(node.items!, entry, `${path}[${index}]`))
    } else add(errors)
  }
  visit(schema, value, 'value')
  if (!details.size) add(violations)
  return [...details].map(message => ({
    code: 'COMPILER_TOOL_SCHEMA_INVALID',
    message: `工具参数未通过工具 Schema 校验：${message.slice(0, 2000)}。草稿未更改；按当前工具 Schema 更正并重新提交参数（已有草稿仍用 repair）。`,
    allowedPaths: [],
  }))
}

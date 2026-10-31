/** Canonicalize JSON objects, retaining array order and all values. This does not
 * cache permissions, results, or model state; it only stabilizes wire layout. */
function orderedJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(orderedJson) as T
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderedJson((value as Record<string, unknown>)[key])])) as T
    }
  }
  return value
}

/** Keep metadata tools stable and the changing submission contract last. The
 * caller must filter tools by current authorization before calling this. */
export function orderedPlanningTools<T extends { name: string; parameters: unknown }>(tools: readonly T[]): T[] {
  return tools.map(tool => ({ ...tool, parameters: orderedJson(tool.parameters) })).sort((left, right) => {
    if (left.name === right.name) return 0
    if (left.name === 'structured_output') return 1
    if (right.name === 'structured_output') return -1
    return left.name < right.name ? -1 : 1
  })
}

/** Shared contracts precede the task delta. Never reorder conversation roles,
 * system policy sections, arrays, or SDK replay history to obtain a prefix. */
export function planningPromptJson(payload: Record<string, unknown>): string {
  const sharedKeys = ['rules', 'templateAccess', 'runtimeSemantics', 'semantics', 'templateCatalog']
  const keys = [...sharedKeys.filter(key => Object.hasOwn(payload, key)), ...Object.keys(payload).filter(key => !sharedKeys.includes(key)).sort()]
  return JSON.stringify(Object.fromEntries(keys.map(key => [key, orderedJson(payload[key])])))
}

/** Only the Host's explicit provenance permits changing its initial input.
 * User prose/JSON, historical messages and repair deltas are never rewritten.
 * The system planning boundary retains the complete authoritative contracts. */
export function deduplicatedPlanningPrompt(prompt: string, source: 'host-template-initial-v1' | undefined, compilerRules: string | undefined, templateAccess: string): string {
  if (source !== 'host-template-initial-v1' || !compilerRules) return prompt
  try {
    const payload: unknown = JSON.parse(prompt)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return prompt
    const value = payload as Record<string, unknown>
    if (Object.hasOwn(value, 'continuation') || value.rules !== compilerRules || value.templateAccess !== templateAccess || !value.templateCatalog || typeof value.templateCatalog !== 'object' || Array.isArray(value.templateCatalog)) return prompt
    return JSON.stringify({ ...value, rules: 'Follow the complete authoritative compiler contract in the system planning boundary.', templateAccess: 'Template access guidance is in the system planning boundary.' })
  } catch { return prompt }
}

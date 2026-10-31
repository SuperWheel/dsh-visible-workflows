/** Only the native edit tool accepts a single config. prefix; handoffs stay canonical. */
export function normalizePlanningEditToolChanges(changes: unknown): unknown {
  if (!Array.isArray(changes)) return changes
  return changes.map(change => {
    if (!change || typeof change !== 'object' || Array.isArray(change) || !['set-config', 'unset-config'].includes(change.op) || typeof change.field !== 'string') return change
    const alias = /^config\.([A-Za-z][A-Za-z0-9_]*)$/.exec(change.field)
    return alias && alias[0] === change.field ? { ...change, field: alias[1] } : change
  })
}

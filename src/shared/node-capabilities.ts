import { z } from 'zod'
import { NODE_LABELS, type NodeKind } from './types.ts'
import { workflowNodeConfigSchema } from './workflow-validation.ts'

/** Describes the same validated config used by the editor and importer. */
export function nodeCapabilityCatalog(kinds: readonly NodeKind[] = Object.keys(NODE_LABELS) as NodeKind[], options:{authoring?:boolean}={}): { kind: NodeKind; description: string; schema: Record<string, unknown> }[] {
  return [...new Set(kinds)].map(kind => {
    const schema = z.toJSONSchema(workflowNodeConfigSchema(kind), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
    // Container configs still use the same body/nodes/edges contract. Only the
    // Host-owned transport fields are projected out, exactly as for root nodes.
    if (kind === 'loop' || kind === 'iteration') {
      const properties = schema.properties as Record<string, Record<string, unknown>>
      const body = properties.body!.properties as Record<string, Record<string, unknown>>
      const omit = (item: Record<string, unknown>, keys: string[]): void => {
        const fields = item.properties as Record<string, unknown>
        for (const key of keys) delete fields[key]
        item.required = (item.required as string[]).filter(key => !keys.includes(key))
      }
      omit(body.nodes!.items as Record<string, unknown>, ['number', 'x', 'y', 'fixed'])
      omit(body.edges!.items as Record<string, unknown>, ['id'])
      // The dictionary teaches CREATE declarations. Runtime/import callers
      // retain the saved graph schema; authoring containers are Host-owned.
      if(options.authoring){delete properties.body;schema.required=(schema.required as string[]??[]).filter(key=>key!=='body')}
    }
    // Zod attaches non-enumerable ~standard metadata to its JSON Schema result.
    // DSH's tool-result snapshot rejects such hidden own properties as non-lossless
    // JSON. Publish only the JSON Schema document, never Zod's runtime protocol.
    return { kind, description: NODE_LABELS[kind], schema: JSON.parse(JSON.stringify(schema)) as Record<string, unknown> }
  })
}

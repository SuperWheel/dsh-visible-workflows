import { readFileSync } from 'node:fs'
import { templateContext } from './template.ts'
import { templateIdForTool } from '../../../src/shared/planning-node-templates.ts'
import { TemplateFillingCompiler } from '../../../src/shared/planning-template-compiler.ts'

export const r12FixtureNames = ['initial-args', 'feedback', 'repair-rejected-args', 'repair-structured-output-tool'] as const
export const r12Fixture = (name: typeof r12FixtureNames[number]): any => JSON.parse(readFileSync(new URL(`./t23-r12-${name}.json`, import.meta.url), 'utf8'))
/** Reconstruct only the local native tool identities/argument slots used by the
 * recording. No tool implementation or model is invoked. Review validation is
 * the production policy, not replayed/canned feedback. */
export function r12Compiler() {
  const context = templateContext()
  context.tools = ['native:glob', 'native:read', 'native:write'].map(id => ({
    id, name: id, description: '离线 r12 工具目录', available: true,
    providerId: 'native', providerName: 'native', category: 'native' as const,
    inputSchema: { type: 'object' as const, additionalProperties: true },
  }))
  const compiler = new TemplateFillingCompiler(context)
  compiler.queryTemplates(['input', 'output', 'template', 'if', 'loop', 'human', 'assigner', ...context.tools.map(tool => templateIdForTool(tool.id))])
  return compiler
}

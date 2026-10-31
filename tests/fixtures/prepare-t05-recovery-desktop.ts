// Prepare T05.8.3 / T05.9.3 Desktop import bundles only. Does not write a
// profile, start UI, execute workflows or call a model. Usage: <output directory>.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TemplateFillingCompiler } from '../../src/shared/planning-template-compiler.ts'
import { exportWorkflowPackage, importWorkflowJson, parseWorkflowPackage } from '../../src/shared/workflow-format.ts'
import { ToolCatalog } from '../../src/host/tool-catalog.ts'
import { templateContext } from './planning-compiler/template.ts'
import { documentWire, dynamicChildWire, dynamicRootWire } from './t05-desktop-recovery-forms.ts'
import type { Workflow } from '../../src/shared/types.ts'

const directory = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Pass the output directory')
mkdirSync(directory, { recursive: true })
const deny = async (): Promise<never> => { throw Error('Fixture construction must not execute actions') }
function compile(id: string, wire: unknown, workflows: Workflow[] = []): Workflow {
  const context = templateContext()
  context.workflow.id = id
  context.nodeIds = context.nodeIds.map((_, index) => `${id}-${index}`)
  context.tools = new ToolCatalog({ directory, workflows: () => workflows, nativeTools: () => [], executeNative: deny, runWorkflow: deny, http: deny }).list('workspace')
  const compiled = new TemplateFillingCompiler(context).submit(wire)
  if (!compiled.ok) throw Error(JSON.stringify(compiled.feedback))
  return compiled.value.candidate!
}
const files: Record<string, string> = {}
function save(name: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + '\n'
  parseWorkflowPackage(text)
  importWorkflowJson(text, 'synthetic-import-validation')
  writeFileSync(join(directory, name), text)
  files[name] = createHash('sha256').update(text).digest('hex')
}
const child = compile('synthetic-t05-8-3-child', dynamicChildWire())
const root = compile('synthetic-t05-8-3-root', dynamicRootWire(child.id), [child])
save('t05-8-3-dynamic-child-bundle.workflow.json', exportWorkflowPackage(root, { workflows: [child] }))
save('t05-9-3-document.workflow.json', exportWorkflowPackage(compile('synthetic-t05-9-3-document', documentWire())))
console.log(JSON.stringify({ directory, files }, null, 2))

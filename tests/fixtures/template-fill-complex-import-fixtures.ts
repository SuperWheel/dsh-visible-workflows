// Mechanical reuse of existing test fixtures; this module starts no provider.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { TemplateFillingCompiler } from '../../src/shared/planning-template-compiler.ts'
import { templateIdForTool } from '../../src/shared/planning-node-templates.ts'
import { exportWorkflowPackage, parseWorkflowPackage } from '../../src/shared/workflow-format.ts'
import { ToolCatalog } from '../../src/host/tool-catalog.ts'
import { templateContext } from './planning-compiler/template.ts'
import { cases, contextFor } from '../../scripts/benchmarks/workflow-compiler.ts'
import type { Workflow } from '../../src/shared/types.ts'

function trustedFixtureFunction(path: string, name: string, bindings: Record<string, unknown> = {}, constants: string[] = []) {
  // Evaluate only the named constructor from trusted repository test source.
  // No test suite, model, action adapter or arbitrary user input is evaluated.
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const target = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(target, `Missing trusted fixture constructor: ${name}`)
  const declarations = constants.map(constant => {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === constant) return 'const ' + declaration.getText(source) + ';'
      }
    }
    throw Error('Missing trusted fixture constant: ' + constant)
  })
  const code = ts.transpileModule(declarations.join('\n') + '\n' + target.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText
  return JSON.parse(JSON.stringify(runInNewContext(code + '\n' + name + '()', bindings, { timeout: 1_000 })))
}
export function deepContainerWire(): any {
  return trustedFixtureFunction('tests/template-fill-complex-containers.test.ts', 'wire', {}, ['createCode'])
}
export function largeEditContext() {
  return trustedFixtureFunction('tests/template-fill-complex-local-edit.test.ts', 'baseline', { cases, contextFor }) as ReturnType<typeof contextFor>
}
export function deepDesktopBundle(directory: string) {
  const childContext = templateContext()
  childContext.workflow.id = 'synthetic-t05-deep-child'
  childContext.nodeIds = childContext.nodeIds.map((_, index) => 'synthetic-deep-' + index)
  const childCompiled = new TemplateFillingCompiler(childContext).submit(deepContainerWire())
  if (!childCompiled.ok) throw Error(JSON.stringify(childCompiled.feedback))
  const child = childCompiled.value.candidate!
  child.title = 'Synthetic T05 deep container child'
  const fields = child.nodes.find(node => node.kind === 'input')!.config.fields!
  const deny = async (): Promise<never> => { throw Error('Fixture construction must not execute actions') }
  const catalog = new ToolCatalog({ directory, workflows: () => [child], nativeTools: () => [], executeNative: deny, runWorkflow: deny, http: deny })
  const rootContext = templateContext()
  rootContext.workflow.id = 'synthetic-t05-deep-parent'
  rootContext.nodeIds = rootContext.nodeIds.map((_, index) => 'synthetic-parent-' + index)
  rootContext.tools = catalog.list('workspace')
  const parentWire = { submission: { mode: 'create', title: 'Synthetic T05 deep subworkflow caller', forms: [
    { key: 'start', template: 'input', values: { fields } },
    { key: 'child', template: templateIdForTool(`workflow:${child.id}`), values: { inputs: Object.fromEntries(fields.map(field => [field.name, `{{input.${field.name}}}`])) } },
    { key: 'result', template: 'output', values: { text: '{{child.outputs.result}}', outputName: 'result' } },
  ], chains: [{ key: 'main', nodes: ['start', 'child', 'result'] }], coverage: { R1: ['child', 'result'] } } }
  const parentCompiled = new TemplateFillingCompiler(rootContext).submit(parentWire)
  if (!parentCompiled.ok) throw Error(JSON.stringify(parentCompiled.feedback))
  const parent = parentCompiled.value.candidate!
  const bundle = exportWorkflowPackage(parent, { workflows: [child] })
  parseWorkflowPackage(JSON.stringify(bundle))
  return { parent, child, parentWire, bundle }
}
export function largeDesktopBaseline(): Workflow {
  const context = largeEditContext()
  context.workflow.id = 'synthetic-t05-large-local-edit'
  context.workflow.title = 'Synthetic T05 31-node local edit baseline'
  context.workflow.revision = 0
  return context.workflow
}

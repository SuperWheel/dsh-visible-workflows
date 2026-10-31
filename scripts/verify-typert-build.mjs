import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

/** Verify generated contracts and renderer imports without opening a Host or credential store. */
export async function verifyTypertBuild(root) {
  const { TYPERT } = await import(pathToFileURL(join(root, 'lib/typert.host.js')).href)
  const { default: remote } = await import(pathToFileURL(join(root, 'lib/typert.remote-client.js')).href)
  const sourcePath = join(root, 'src/host/index.ts')
  const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true)
  const declared = []
  for (const statement of source.statements) if (ts.isClassDeclaration(statement)) {
    for (const member of statement.members) if (ts.isMethodDeclaration(member) && ts.canHaveDecorators(member)) {
      for (const decorator of ts.getDecorators(member) ?? []) {
        const call = decorator.expression
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'Remote') continue
        const name = call.arguments[0]
        assert(name && ts.isStringLiteral(name), 'Remote export must have an explicit name')
        declared.push(name.text)
      }
    }
  }
  assert(declared.length > 0, 'Host Remote declarations were not found')
  assert.equal(new Set(declared).size, declared.length, 'Duplicate authored Remote name')
  assert.deepEqual(TYPERT.invocations.map(item => item.method).sort(), [...declared].sort())
  assert.deepEqual(remote.descriptors.map(item => item.method).sort(), [...declared].sort())
  for (const host of TYPERT.invocations) {
    const client = remote.methods[`${host.namespace}/${host.method}`]
    assert(client, `Missing Client Remote: ${host.method}`)
    // Compare every emitted wire/schema fact, excluding executable callbacks.
    assert.deepEqual(JSON.parse(JSON.stringify(client)), JSON.parse(JSON.stringify(host)))
    for (const parameter of host.parameters) {
      assert.equal(typeof parameter.codec?.create, 'function', `Missing Host parameter schema: ${host.method}/${parameter.name}`)
      assert.equal(typeof parameter.strictCodec?.create, 'function', `Missing strict parameter schema: ${host.method}/${parameter.name}`)
    }
    assert.equal(typeof host.result.create, 'function', `Missing result schema: ${host.method}`)
  }
  const allowed = new Set(['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const imports = [...new Set([...bundle.matchAll(/\brequire\("([^"\n]+)"\)/g)].map(match => match[1]))].sort()
  assert(imports.length > 0, 'Client bundle module wrapper was not found')
  for (const specifier of imports) assert(allowed.has(specifier), `Client dependency must be bundled or explicitly registered as a Host seed: ${specifier}`)
  return { remoteMethods: declared.length, hostClientSchemasMatch: true, clientImports: imports }
}

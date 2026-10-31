import { describe, expect, it } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)

/**
 * Real 0.2.0-rc.2 integration regression: `remove` passed the Host generator but
 * Client $mount rejected it because RemoteNamespaceService owns remove(). The
 * SDK ships readable JS beside its public types; inspect that installed contract
 * rather than copy this plugin's names into an expected-value test. A future SDK
 * layout change fails explicitly so the integration check cannot silently vanish.
 */
function reservedSdkNames(): Set<string> {
  const root = dirname(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))
  const sdk = source(join(root, 'lib/types/client/index.js'))
  const namespace = sdk.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'RemoteNamespaceService')
  if (!namespace || !ts.isClassDeclaration(namespace)) throw new Error('SDK namespace contract moved; inspect the new SDK before updating this test')
  const names = new Set<string>()
  for (const member of namespace.members) if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) names.add(member.name.text)
  for (let prototype = Service.prototype; prototype; prototype = Object.getPrototypeOf(prototype)) for (const name of Object.getOwnPropertyNames(prototype)) names.add(name)
  let foundReservedFields = false
  for (const statement of sdk.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'REMOTE_NAMESPACE_FIELDS') continue
    const initializer = declaration.initializer
    if (!initializer || !ts.isNewExpression(initializer)) continue
    const fields = initializer.arguments?.[0]
    if (!fields || !ts.isArrayLiteralExpression(fields)) continue
    foundReservedFields = true
    for (const field of fields.elements) if (ts.isStringLiteral(field)) names.add(field.text)
  }
  if (!foundReservedFields) throw new Error('SDK reserved-field contract moved; update the contract check explicitly')
  return names
}

function exportedRemoteNames(): string[] {
  const host = source(new URL('../src/host/index.ts', import.meta.url).pathname)
  const names: string[] = []
  for (const statement of host.statements) if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
    if (!ts.isMethodDeclaration(member) || !ts.canHaveDecorators(member)) continue
    for (const decorator of ts.getDecorators(member) ?? []) {
      const expression = decorator.expression
      if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression) || expression.expression.text !== 'Remote') continue
      const exported = expression.arguments[0]
      if (exported && ts.isStringLiteral(exported)) names.push(exported.text)
      else if (member.name && ts.isIdentifier(member.name)) names.push(member.name.text)
    }
  }
  if (!names.length) throw new Error('No Remote declarations found; this test must inspect the actual Host contract')
  return names
}

describe('已安装 SDK 的 Remote namespace 契约', () => {
  it('Host 暴露的方法不碰 Client 原型或内部字段的保留名称', () => {
    const reserved = reservedSdkNames()
    // This assertion proves that the original broken export would be rejected.
    expect(reserved.has('remove')).toBe(true)
    const conflicts = exportedRemoteNames().filter(name => reserved.has(name))
    expect(conflicts).toEqual([])
  })
})

// Load the real decorated Host through its supported TS loader; Vite's OXC runner
// does not lower these SDK standard decorators. The child creates actual Cordis
// plugin contexts and invokes the production service, with inert model/tool providers.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

describe('真实 Cordis 插件依赖及执行上下文',()=>{
  it('validates service injection, optional sandbox lookup and scoped native dispatch',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/host-cordis-fixture.ts',import.meta.url).pathname],{timeout:10_000})
    expect(JSON.parse(stdout.trim())).toEqual({ok:true,cases:['builtin-without-agent','optional-sandbox','native-denied-without-agent','native-scoped-execute','other-workspace-builtin-only']})
  })
})

describe('真实 SDK 系统提示词与工作流模板语法兼容',()=>{
  it('普通聊天组装保留生产 Host 的模板示例，去掉 literal 标记会复现原错误，原生及工具 SDK 文档均不损坏',async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',new URL('./fixtures/host-cordis-fixture.ts',import.meta.url).pathname,'--prompt-contract'],{timeout:10_000})
    expect(JSON.parse(stdout.trim())).toEqual({ok:true,cases:[
      'native-ordinary-chat-literal-guidance','native-old-config-reproduces-malformed-variable','native-production-tool-braces-preserved',
      'ptc-ordinary-chat-literal-guidance','ptc-old-config-reproduces-malformed-variable','ptc-production-tool-braces-preserved',
    ]})
  })
})

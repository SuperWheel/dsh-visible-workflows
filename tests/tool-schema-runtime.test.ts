import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCatalog, executeBuiltin, parseSwagger, validateArguments } from '../src/host/tool-catalog.ts'
import { createExecutionAdapters } from '../src/host/execution-adapters.ts'
import { WorkflowRuntime, type AdapterRequest } from '../src/host/runtime.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { makeWorkflow, type JsonValue } from '../src/shared/types.ts'

type Data = Record<string, JsonValue>
const directories: string[] = [], runtimes: WorkflowRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'workflow-tool-schema-')); directories.push(directory); return directory }
const request = (): AdapterRequest => ({ node: { id: 'tool', number: 'a-2', kind: 'tool', title: 'Tool', x: 0, y: 0, fixed: false, config: {} }, inputs: {}, workspaceId: 'w', runId: 'r', signal: new AbortController().signal, backend: { generate: async () => { throw new Error('No model calls') } } })
const swagger = (schema: Data) => JSON.stringify({ openapi: '3.0.0', info: { title: 'Schema' }, servers: [{ url: 'https://example.invalid' }], components: { schemas: { Body: schema } }, paths: { '/check': { post: { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } } } } } } })
const bodySchema: Data = { type: 'object', properties: { mode: { type: 'string', const: 'safe' }, rows: { type: 'array', items: { oneOf: [{ type: 'integer' }, { type: 'boolean' }] } } }, required: ['mode', 'rows'], additionalProperties: false }
function fixture() {
  const directory = temporary(), http = vi.fn(async (_url: string, _method: string, _headers: Record<string, string>, _body: string | undefined): Promise<Data> => ({ text: 'accepted' }))
  const catalog = new ToolCatalog({ directory, workflows: () => [], nativeTools: () => [], executeNative: async () => ({}), runWorkflow: async () => ({}), http })
  return { directory, http, catalog }
}

describe('resolved tool arguments use the enforced JSON schema contract', () => {
  it.each([
    { body: { mode: 'unsafe', rows: [1] } },
    { body: { mode: 'safe', rows: [1], extra: true } },
    { body: { mode: 'safe', rows: [1, 'wrong'] } },
  ])('rejects a dereferenced Swagger violation before HTTP: %j', async args => {
    const { catalog, http } = fixture(), [tool] = catalog.importSwagger('w', swagger(bodySchema))
    await expect(catalog.execute(tool!.id, args, request())).rejects.toThrow()
    expect(http).not.toHaveBeenCalled()
  })
  it('accepts the exact nested scalar union and preserves the HTTP body', async () => {
    const { catalog, http } = fixture(), [tool] = catalog.importSwagger('w', swagger(bodySchema)), args = { body: { mode: 'safe', rows: [1, true, 2, false] } }
    await expect(catalog.execute(tool!.id, args, request())).resolves.toEqual({ text: 'accepted' })
    expect(http).toHaveBeenCalledOnce(); expect(http.mock.calls[0]![3]).toBe(JSON.stringify(args.body))
  })
  it('requires exactly one matching branch, including overlapping numeric branches', () => {
    expect(() => validateArguments({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1)).toThrow('oneOf')
    expect(() => validateArguments({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1.5)).not.toThrow()
  })
  it.each(['minimum', 'pattern', 'format'])('reports an unsupported Swagger keyword at import instead of silently dropping %s', keyword => {
    const schema: Data = { type: keyword === 'minimum' ? 'number' : 'string', [keyword]: keyword === 'minimum' ? 1 : 'test' }
    expect(() => parseSwagger('w', swagger(schema))).toThrow(/OpenAPI.*参数合同.*支持/)
  })
  it('keeps Swagger 2 primitive parameters without optional descriptions usable', async () => {
    const { catalog, http } = fixture(), [tool] = catalog.importSwagger('w', JSON.stringify({ swagger: '2.0', host: 'example.invalid', paths: { '/check': { get: { parameters: [{ name: 'id', in: 'query', type: 'integer', required: true }] } } } }))
    await catalog.execute(tool!.id, { id: 3 }, request()); expect(http.mock.calls[0]![0]).toBe('https://example.invalid/check?id=3')
  })
  it('keeps builtin unconstrained JSON arguments and rejects non-finite values', () => {
    expect(executeBuiltin('builtin:json.stringify', { value: { nested: [null, true, 3] } })).toEqual({ text: '{"nested":[null,true,3]}' })
    expect(() => executeBuiltin('builtin:time.from_timestamp', { timestamp: Number.NaN })).toThrow()
  })
  it.each(['safe', 'unsafe'])('validates %s after the runtime resolves an input reference, before the adapter action', async mode => {
    const { catalog, http, directory } = fixture(), [tool] = catalog.importSwagger('w', swagger(bodySchema)), storage = new WorkflowStorage(directory)
    const runtime = new WorkflowRuntime(storage, request().backend, createExecutionAdapters({ catalog, workspaceRoot: () => directory })); runtimes.push(runtime)
    const graph = makeWorkflow('w', 'Runtime schema', true)
    graph.nodes[1]!.kind = 'tool'; graph.nodes[1]!.config = { toolId: tool!.id, inputs: { body: { mode: '{{input.text}}', rows: [1, true] } } }
    const saved = storage.save(graph, 0), done = await runtime.settle(runtime.start(saved.id, { text: mode }).id)
    expect(done.status).toBe(mode === 'safe' ? 'success' : 'failed')
    expect(http).toHaveBeenCalledTimes(mode === 'safe' ? 1 : 0)
    if (mode === 'safe') expect(http.mock.calls[0]![3]).toBe('{"mode":"safe","rows":[1,true]}')
    else expect(done.error).toContain('参数.body.mode')
  })
})


describe('Swagger 2 top-level parameter contracts',()=>{
  const document=(parameter:Record<string,unknown>)=>JSON.stringify({swagger:'2.0',host:'example.invalid',paths:{'/check':{get:{parameters:[{name:'mode',in:'query',required:true,...parameter}]}}}})
  it('keeps enum and array item constraints and blocks invalid arguments before HTTP',async()=>{
    const {catalog,http}=fixture(),[tool]=catalog.importSwagger('w',document({type:'array',items:{type:'string',enum:['safe']},collectionFormat:'multi'}))
    expect(tool!.inputSchema.properties).toMatchObject({mode:{type:'array',items:{type:'string',enum:['safe']}}})
    await expect(catalog.execute(tool!.id,{mode:['unsafe']},request())).rejects.toThrow('工具参数无效')
    expect(http).not.toHaveBeenCalled()
    await catalog.execute(tool!.id,{mode:['safe','safe']},request())
    expect(http.mock.calls[0]![0]).toBe('https://example.invalid/check?mode=safe&mode=safe')
  })
  it.each(['query','path','header'])('keeps a referenced %s enum parameter and rejects unsafe values',async location=>{
    const {catalog,http}=fixture(),raw=JSON.parse(document({in:location,type:'string',enum:['safe']}))
    raw.parameters={Mode:raw.paths['/check'].get.parameters[0]};raw.paths['/check'].parameters=[{$ref:'#/parameters/Mode'}];raw.paths['/check'].get.parameters=[]
    const [tool]=catalog.importSwagger('w',JSON.stringify(raw))
    expect(tool!.inputSchema.properties).toMatchObject({mode:{enum:['safe']}})
    await expect(catalog.execute(tool!.id,{mode:'unsafe'},request())).rejects.toThrow()
    expect(http).not.toHaveBeenCalled()
    await catalog.execute(tool!.id,{mode:'safe'},request());expect(http).toHaveBeenCalledOnce()
  })
  it.each([
    {type:'number',minimum:1},{type:'number',maximum:5},{type:'number',exclusiveMinimum:true},
    {type:'number',multipleOf:2},{type:'string',format:'date-time'},{type:'string',pattern:'^safe$'},
    {type:'string',minLength:2},{type:'array',items:{type:'string'},maxItems:2},
    {type:'array',items:{type:'string',format:'email'}},{type:'string',allowEmptyValue:true},
  ])('rejects unsupported constraints during import instead of losing them: %j',parameter=>{
    expect(()=>parseSwagger('w',document(parameter))).toThrow(/OpenAPI.*参数合同.*支持/)
  })
  it('rejects unsupported parameter serialization explicitly',()=>{
    expect(()=>parseSwagger('w',document({type:'array',items:{type:'string'},collectionFormat:'pipes'}))).toThrow('collectionFormat')
  })
})

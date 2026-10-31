import {afterEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ToolCatalog} from '../src/host/tool-catalog.ts'
import {makeWorkflow,type ToolChoice} from '../src/shared/types.ts'
import type {AdapterRequest} from '../src/host/runtime.ts'

const dirs:string[]=[]
afterEach(()=>{for(const directory of dirs.splice(0))rmSync(directory,{recursive:true,force:true})})
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'workflow-contract-'));dirs.push(directory)
 const native:ToolChoice={id:'native:read_file',name:'read_file',description:'Read',providerId:'native:harness',providerName:'Harness',category:'plugin',available:true,inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}
 const workflow=makeWorkflow('w'),executeNative=vi.fn(async()=>({text:'native'})),runWorkflow=vi.fn(async()=>({text:'frozen child'})),http=vi.fn(async()=>({text:'HTTP'}))
 const catalog=new ToolCatalog({directory,workflows:()=>[workflow],nativeTools:(_workspace,session)=>session?[native]:[],sessionForRun:()=> 'session',executeNative,runWorkflow,http})
 const request:AdapterRequest={node:{id:'n',number:'a-1',title:'tool',kind:'tool',x:0,y:0,fixed:false,config:{}},inputs:{},workspaceId:'w',runId:'r',signal:new AbortController().signal,backend:{generate:async()=>''}}
 return {catalog,request,native,workflow,executeNative,runWorkflow,http}
}
const swagger=(location:string)=>JSON.stringify({openapi:'3.0.0',info:{title:'API'},servers:[{url:'https://example.invalid'}],paths:{'/items':{get:{parameters:[{name:'token',in:location,required:true,schema:{type:'string'}}]}}}})
describe('frozen tool contracts',()=>{
 it('hashes builtin contracts and skips workflow / unavailable agentless native contracts',()=>{
  const {catalog,workflow}=fixture(),constraints=catalog.constraints('w',['builtin:json.parse',`workflow:${workflow.id}`,'native:read_file'])
  expect(constraints['builtin:json.parse']).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(constraints)).toEqual(['builtin:json.parse'])
 })
 it('lists builtin tools with their known plugin contract and keeps their frozen digests unchanged (T18)',()=>{
  const {catalog}=fixture(),parse=catalog.list('w').find(tool=>tool.id==='builtin:json.parse')!
  expect(parse.operationContract).toMatchObject({status:'known',source:'plugin-builtin',declaration:{sourceId:'builtin-tool:json.parse',scope:{owner:'none',target:'none'},action:{kind:'other'}}})
  // Digests recorded before builtin contracts existed: runs frozen earlier still resume.
  expect(catalog.constraints('w',['builtin:json.parse','builtin:time.now'])).toEqual({'builtin:json.parse':'a5b5331dbd71af63b2fe1425b8a9eeecadf26bae3640b326c73c42fe93b3dc84','builtin:time.now':'77eb464fc1f13c3a842471605445a9978ee0ef8cffffe829d3b738b8bd79ef69'})
 })
 it('rejects changed API parameter routing before making an HTTP request',async()=>{
  const {catalog,request,http}=fixture(),[tool]=catalog.importSwagger('w',swagger('query'))
  request.toolConstraints=catalog.constraints('w',[tool!.id])
  catalog.importSwagger('w',swagger('header'))
  await expect(catalog.execute(tool!.id,{token:'ordinary-config'},request)).rejects.toThrow('工具定义已变化')
  expect(http).not.toHaveBeenCalled()
 })
 it('rejects native schema drift but accepts the unchanged frozen contract',async()=>{
  const {catalog,request,native,executeNative}=fixture()
  request.toolConstraints=catalog.constraints('w',['native:read_file'],'session')
  await expect(catalog.execute('native:read_file',{path:'file'},request)).resolves.toEqual({text:'native'})
  native.inputSchema={type:'object',properties:{path:{type:'string'},secret:{type:'string'}},required:['path','secret']}
  await expect(catalog.execute('native:read_file',{path:'file'},request)).rejects.toThrow('工具定义已变化')
  expect(executeNative).toHaveBeenCalledTimes(1)
 })
 it('never validates a frozen child call using the latest workflow input schema',async()=>{
  const {catalog,request,workflow,runWorkflow}=fixture()
  request.toolConstraints={}
  workflow.nodes[0]!.config.fields=[{name:'new_required_parameter',label:'new',required:true}]
  await expect(catalog.execute(`workflow:${workflow.id}`,{old_frozen_input:'value'},request)).resolves.toEqual({text:'frozen child'})
  expect(runWorkflow).toHaveBeenCalledWith(workflow.id,{old_frozen_input:'value'},request)
 })
 it('does not accept a forged or missing builtin constraint in a frozen run',async()=>{
  const {catalog,request}=fixture();request.toolConstraints={}
  await expect(catalog.execute('builtin:json.parse',{text:'{}'},request)).rejects.toThrow('工具定义已变化')
 })
})

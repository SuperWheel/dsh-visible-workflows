import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { BUILTIN_TOOLS, ToolCatalog, executeBuiltin, parseSwagger } from '../src/host/tool-catalog.ts'
import { createExecutionAdapters, extractDocument, httpRequest, runJavaScript, boundedProcess, PYTHON_BOOTSTRAP } from '../src/host/execution-adapters.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'
import { makeWorkflow, type WorkflowNode } from '../src/shared/types.ts'
const dirs:string[]=[]
const temporary=()=>{const dir=mkdtempSync(join(tmpdir(),'visible-adapters-'));dirs.push(dir);return dir}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
const request=(kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):AdapterRequest=>({node:{id:'n',number:'a-1',kind,title:'Test',x:0,y:0,fixed:false,config},inputs:{},workspaceId:'w',runId:'r',signal:new AbortController().signal,backend:{generate:async()=>'{"final":"done"}'}})
describe('real tool catalog',()=>{
 it('runs the advertised five time operations and JSON operation',()=>{
  expect(BUILTIN_TOOLS.filter(t=>t.providerId==='builtin:time')).toHaveLength(5)
  expect(executeBuiltin('builtin:time.from_timestamp',{timestamp:0,timezone:'UTC'}).iso).toBe('1970-01-01T00:00:00.000Z')
  expect(executeBuiltin('builtin:time.convert_timezone',{datetime:'2026-01-01T00:00:00Z',timezone:'Asia/Shanghai'}).text).toBe('2026-01-01 08:00:00')
  expect(executeBuiltin('builtin:json.select',{value:{rows:[{x:3}]},path:'rows.0.x'}).value).toBe(3)
  expect(()=>executeBuiltin('builtin:json.select',{value:{},path:'constructor'})).toThrow()
  expect(()=>executeBuiltin('builtin:time.from_timestamp',{timestamp:'not a number'})).toThrow()
 })
 it('imports local-ref OpenAPI operations, calls the configured HTTP method and persists workspace scope',async()=>{
  const directory=temporary(),calls:unknown[]=[]
  const options={directory,workflows:()=>[],nativeTools:()=>[],executeNative:async()=>({text:''}),runWorkflow:async()=>({text:''}),http:async(...args:unknown[])=>{calls.push(args);return {text:'ok'}}}
  const catalog=new ToolCatalog(options)
  const spec=JSON.stringify({
   openapi:'3.0.0',info:{title:'Example'},servers:[{url:'https://example.invalid/api'}],
   components:{schemas:{Body:{type:'object',properties:{title:{type:'string'}},required:['title']}}},
   paths:{'/items/{id}':{post:{
    summary:'Create',parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}},{name:'q',in:'query',schema:{type:'string'}}],
    requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Body'}}}}
   }}}
  })
  const [tool]=catalog.importSwagger('w',spec)
  await catalog.execute(tool!.id,{id:'a/b',q:'hello world',body:{title:'real'}},request('tool'))
  expect((calls[0] as unknown[])[0]).toBe('https://example.invalid/api/items/a%2Fb?q=hello+world')
  expect((calls[0] as unknown[])[1]).toBe('POST')
  expect(new ToolCatalog(options).list('w').some(t=>t.id===tool!.id)).toBe(true)
  expect(new ToolCatalog(options).list('another').some(t=>t.id===tool!.id)).toBe(false)
  await expect(catalog.execute(tool!.id,{id:'x',body:{}},request('tool'))).rejects.toThrow('title')
 })
 it('rejects remote schema references and marks human-containing workflows unavailable as tools',()=>{
  expect(()=>parseSwagger('w',JSON.stringify({openapi:'3.0',servers:[{url:'https://example.invalid'}],paths:{'/':{get:{parameters:[{$ref:'https://example.invalid/secret'}]}}}}))).toThrow('文档内')
  const flow=makeWorkflow('w');flow.nodes.push({...flow.nodes[0]!,id:'human',kind:'human'})
  const catalog=new ToolCatalog({directory:temporary(),workflows:()=>[flow],nativeTools:()=>[],executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({})})
  expect(catalog.list('w').find(t=>t.id===`workflow:${flow.id}`)?.available).toBe(false)
 })
})
describe('isolated and bounded execution adapters',()=>{
 it('executes real JavaScript with typed inputs and denies host IO',async()=>{
  expect(await runJavaScript('function main(inputs){return {sum:inputs.items.reduce((a,b)=>a+b,0)}}',{items:[1,2,3]},new AbortController().signal)).toEqual({sum:6})
  await expect(runJavaScript('function main(){return {x:process.env}}',{},new AbortController().signal)).rejects.toThrow('process')
  await expect(runJavaScript('function main(){while(true){}return {}}',{},new AbortController().signal,100)).rejects.toThrow()
 })
 it('denies cancelled JS and non-object output',async()=>{
  const controller=new AbortController();controller.abort()
  await expect(runJavaScript('function main(){return {}}',{},controller.signal)).rejects.toThrow()
  await expect(runJavaScript('function main(){return [1]}',{},new AbortController().signal)).rejects.toThrow('对象')
  await expect(runJavaScript('async function main(){return {ok:true}}',{},new AbortController().signal)).rejects.toThrow('同步')
  await expect(runJavaScript('function main(){return {x:NaN}}',{},new AbortController().signal)).rejects.toThrow('JSON')
 })
 it('extracts local files and uploaded file arrays while rejecting workspace escape',async()=>{
  const dir=temporary(),other=temporary();writeFileSync(join(dir,'note.md'),'real document');writeFileSync(join(other,'secret.txt'),'secret');symlinkSync(join(other,'secret.txt'),join(dir,'escape.txt'))
  expect((await extractDocument(dir,'note.md',new AbortController().signal)).text).toBe('real document')
  const upload={name:'attached.txt',base64:Buffer.from('attached').toString('base64')}
  expect((await extractDocument(dir,[upload,upload],new AbortController().signal)).text).toBe('attached\n\nattached')
  await expect(extractDocument(dir,'escape.txt',new AbortController().signal)).rejects.toThrow('工作区')
  await expect(extractDocument(dir,{name:'bad.txt',base64:'not base64 !'},new AbortController().signal)).rejects.toThrow('base64')
 })
 it('Python syntax validator rejects import and reflection before any user code runs',async()=>{
  // Runs only the trusted validator on rejected input, never accepts unconfined user code.
  await expect(boundedProcess(['python3','-I','-c',PYTHON_BOOTSTRAP],JSON.stringify({code:'def main(inputs):\n import os\n return {}',inputs:{}}),new AbortController().signal)).rejects.toThrow('Import')
  await expect(boundedProcess(['python3','-I','-c',PYTHON_BOOTSTRAP],JSON.stringify({code:'def main(inputs):\n return {"x": inputs.__class__}',inputs:{}}),new AbortController().signal)).rejects.toThrow('Attribute')
 })
 it('uses the prepared absolute Python runtime only through the existing sandbox gate',async()=>{
  const dir=temporary(),catalog=new ToolCatalog({directory:dir,workflows:()=>[],nativeTools:()=>[],executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({})}),python='/private/workflow-runtime/python/bin/python3',req=request('code',{language:'python',code:'def main(inputs):\n return {}'})
  let prepared=0,confined:readonly string[]|undefined
  const pythonExecutable=async(signal:AbortSignal)=>{expect(signal).toBe(req.signal);prepared++;return python}
  const denied=createExecutionAdapters({catalog,workspaceRoot:()=>dir,pythonExecutable})
  await expect(denied.execute('code',req)).rejects.toThrow('文件沙箱');expect(prepared).toBe(0)
  const adapter=createExecutionAdapters({catalog,workspaceRoot:()=>dir,pythonExecutable,confinePython:async(argv,root,signal)=>{expect(root).toBe(dir);expect(signal).toBe(req.signal);confined=argv;throw new Error('sandbox denied')}})
  await expect(adapter.execute('code',req)).rejects.toThrow('sandbox denied')
  expect(prepared).toBe(1);expect(confined?.slice(0,3)).toEqual([python,'-I','-c']);expect(confined?.[3]).toBe(PYTHON_BOOTSTRAP)
 })
 it('uses actual HTTP responses, preserves status and never follows credential-bearing redirects',async()=>{
  const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/secret'});res.end();return}res.setHeader('Content-Type','application/json');res.setHeader('Set-Cookie','secret=hidden');res.end(JSON.stringify({method:req.method,path:req.url}))})
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  try {const port=(server.address() as {port:number}).port;const result=await httpRequest(`http://127.0.0.1:${port}/ok`,'POST',{},'{"ok":true}',new AbortController().signal);expect(result.json).toEqual({method:'POST',path:'/ok'});expect(result.headers).not.toHaveProperty('set-cookie');expect((await httpRequest(`http://127.0.0.1:${port}/redirect`,'GET',{},undefined,new AbortController().signal)).status_code).toBe(302)}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
 })
 it('runs an Agent decision loop only through explicitly selected actual tools',async()=>{
  const dir=temporary(),catalog=new ToolCatalog({directory:dir,workflows:()=>[],nativeTools:()=>[],executeNative:async()=>{throw new Error('must not call')},runWorkflow:async()=>({}),http:async()=>({})}),adapter=createExecutionAdapters({catalog,workspaceRoot:()=>dir})
  const req=request('agent',{model:{provider:'p',model:'m'},tools:['builtin:json.parse'],maxSteps:3});let calls=0
  req.backend.generate=async()=>++calls===1?'{"tool":"builtin:json.parse","arguments":{"text":"{\\"x\\":2}"}}':'{"final":"finished"}'
  const result=await adapter.execute('agent',req);expect(result.text).toBe('finished');expect(result.tool_results).toHaveLength(1)
  req.backend.generate=async()=>'{"tool":"native:write_file","arguments":{}}'
  await expect(adapter.execute('agent',req)).rejects.toThrow('未授权')
  await expect(adapter.execute('code',request('code',{language:'python',code:'def main(inputs):\n return {}'}))).rejects.toThrow('文件沙箱')
 })
})

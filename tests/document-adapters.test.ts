import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionAdapters, documentText, extractDocument } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import { graphIssues, parseWorkflow } from '../src/host/validation.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'
import { makeWorkflow, type JsonValue, type NodeConfig, type ToolChoice } from '../src/shared/types.ts'

type Data=Record<string,JsonValue>
const dirs:string[]=[]
const temporary=()=>{const dir=mkdtempSync(join(tmpdir(),'visible-document-'));dirs.push(dir);return dir}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
const file={name:'report.pdf',mimeType:'application/pdf',base64:Buffer.from('%PDF actual test bytes').toString('base64')}
const choice:ToolChoice={id:'native:parse_document',name:'读取文档',description:'Read a local path or uploaded document.',providerId:'mcp:documents',providerName:'Documents',category:'mcp',available:true,inputSchema:{type:'object',properties:{file:{},format:{type:'string'}},required:['file']}}
function fixture(config:NodeConfig={documentMode:'tool',toolId:choice.id,documentSourceKey:'file',documentTextPath:'value.text'},available:ToolChoice[]=[choice]){
 const dir=temporary(),execute=vi.fn(async(_id:string,_args:Data,_request:AdapterRequest):Promise<Data>=>({value:{text:'实际解析结果'}})),readAttachment=vi.fn((runId:string,id:string)=>{if(runId!=='run-a'||id!=='file-a')throw new Error('附件不属于本次运行');return file}),catalog=new ToolCatalog({directory:dir,workflows:()=>[],nativeTools:()=>available,executeNative:execute,runWorkflow:async()=>({}),http:async()=>({})})
 const request:AdapterRequest={node:{id:'document',number:'a-2',title:'解析',kind:'document',x:0,y:0,fixed:false,config},inputs:{source:{workflowFileId:'file-a',name:'report.pdf'}},workspaceId:'workspace-a',runId:'run-a',signal:new AbortController().signal,backend:{generate:vi.fn(async()=>{throw new Error('本测试不应调用模型')})}}
 const adapter=createExecutionAdapters({catalog,workspaceRoot:id=>{expect(id).toBe('workspace-a');return dir},sessionForRun:id=>{expect(id).toBe('run-a');return 'session-a'},readAttachment})
 return {dir,request,execute,readAttachment,run:()=>adapter.execute('document',request)}
}

describe('document parsing sources',()=>{
 it('keeps local UTF-8 text, JSON and CSV and rejects complex/binary files without Python parsing',async()=>{
  const dir=temporary(),signal=new AbortController().signal
  for(const [name,body] of Object.entries({'note.md':'# 标题\n正文','data.json':'{"a":1}','table.csv':'a,b\n1,2'})){
   writeFileSync(join(dir,name),body);expect((await extractDocument(dir,name,signal)).text).toBe(body)
  }
  await expect(extractDocument(dir,file,signal)).rejects.toThrow('指定工具')
  await expect(extractDocument(dir,{...file,name:'disguised.txt',base64:Buffer.from([0xff,0xfe]).toString('base64')},signal)).rejects.toThrow('UTF-8')
  await expect(extractDocument(dir,{...file,name:'disguised.txt',base64:Buffer.from([0,1,2]).toString('base64')},signal)).rejects.toThrow('二进制')
 })
 it('resolves a private run attachment only to the selected source parameter and extracts the exact text path',async()=>{
  const f=fixture();f.request.inputs.format='markdown'
  expect(await f.run()).toEqual({text:'实际解析结果',source:'report.pdf',characters:6})
  expect(f.readAttachment).toHaveBeenCalledExactlyOnceWith('run-a','file-a')
  expect(f.execute).toHaveBeenCalledExactlyOnceWith('parse_document',{format:'markdown',file},f.request)
  expect(f.request.inputs.source).toEqual({workflowFileId:'file-a',name:'report.pdf'})
 })
 it('does not read attachments or choose another parser when the selected MCP is missing or unavailable',async()=>{
  for(const available of [[],[{...choice,available:false,unavailableReason:'当前对话未授权'}]]){
   const f=fixture(undefined,available);await expect(f.run()).rejects.toThrow('不会改用其他解析器')
   expect(f.execute).not.toHaveBeenCalled();expect(f.readAttachment).not.toHaveBeenCalled()
  }
 })
 it('keeps attachments bound to their run and blocks a local symlink outside the workspace before a tool call',async()=>{
  const f=fixture();f.request.inputs.source={workflowFileId:'another-run-file'}
  await expect(f.run()).rejects.toThrow('附件不属于');expect(f.execute).not.toHaveBeenCalled()
  const other=temporary();writeFileSync(join(other,'secret.txt'),'secret');symlinkSync(join(other,'secret.txt'),join(f.dir,'escape.txt'))
  f.request.inputs.source='escape.txt';await expect(f.run()).rejects.toThrow('工作区');expect(f.execute).not.toHaveBeenCalled()
 })
 it('passes verified canonical paths to tools without pretending paths are uploaded bytes',async()=>{
  const f=fixture();writeFileSync(join(f.dir,'report.pdf'),'%PDF bytes');f.request.inputs.source='report.pdf'
  await f.run();expect(f.execute.mock.calls[0]?.[1].file).toBe(realpathSync(join(f.dir,'report.pdf')))
 })
 it('validates the configured tool argument schema before calling a parser',async()=>{
  const f=fixture({documentMode:'tool',toolId:choice.id,documentSourceKey:'wrong_key'})
  await expect(f.run()).rejects.toThrow('file');expect(f.execute).not.toHaveBeenCalled()
 })
 it('strictly rejects invalid JSON, missing paths, unsafe paths and non-text results',()=>{
  expect(documentText({text:'{"result":{"text":"parsed"}}'},'text.result.text')).toBe('parsed')
  expect(()=>documentText({text:'not json'},'text.result')).toThrow('有效 JSON')
  expect(()=>documentText({value:{text:42}},'value.text')).toThrow('字符串')
  expect(()=>documentText({text:'present'},'missing')).toThrow('缺少')
  expect(()=>documentText({},'__proto__.text')).toThrow('无效')
 })
 it('rejects attachment encoding echoed as text and redacts it from parser errors',async()=>{
  const f=fixture();f.execute.mockResolvedValue({value:{text:file.base64}})
  await expect(f.run()).rejects.toThrow('附件编码')
  f.execute.mockRejectedValue(new Error(`parser failed: ${file.base64}`))
  try{await f.run();expect.fail('must reject')}catch(error){expect(String(error)).not.toContain(file.base64);expect(String(error)).toContain('[附件内容仅传给工具]')}
 })
 it('propagates cancellation before parsing and discards a late tool result after cancellation',async()=>{
  const f=fixture(),controller=new AbortController();f.request.signal=controller.signal
  f.execute.mockImplementation(async()=>{controller.abort(new Error('用户取消'));return {value:{text:'late'}}})
  await expect(f.run()).rejects.toThrow('用户取消');expect(f.execute).toHaveBeenCalledOnce()
  f.execute.mockClear();await expect(f.run()).rejects.toThrow('用户取消');expect(f.execute).not.toHaveBeenCalled()
 })
})

describe('document Agent tool execution',()=>{
 const agentConfig:NodeConfig={documentMode:'agent',model:{provider:'dsh',model:'selected'},effort:'low',tools:[choice.id],maxSteps:3,prompt:'提取原文'}
 it('executes the selected file-reading tool with typed bytes while excluding raw bytes from model context and result',async()=>{
  const f=fixture(agentConfig),prompts:string[]=[];f.request.rolePrompt='保持原文结构'
  f.execute.mockResolvedValue({text:'解析完成',file})
  f.request.backend.generate=vi.fn(async args=>{
   expect(args.model).toEqual(agentConfig.model);expect(args.effort).toBe('low');expect(args.system).toContain('保持原文结构');prompts.push(args.prompt)
   return prompts.length===1?JSON.stringify({tool:choice.id,arguments:{file:'__DOCUMENT_SOURCE__'}}):JSON.stringify({final:{text:'文档正文'}})
  })
  const result=await f.run();expect(result).toMatchObject({text:'文档正文',source:'report.pdf',steps:2,parser:'agent'})
  expect(f.execute.mock.calls[0]?.[1]).toEqual({file})
  expect(JSON.stringify(result)).not.toContain(file.base64);expect(prompts.join('\n')).not.toContain(file.base64)
  expect(prompts[1]).toContain('[附件内容仅传给工具]')
 })
 it('rejects invented final answers, malformed decisions and tools outside the selected set',async()=>{
  for(const [response,error] of [
   ['{"final":{"text":"guessed"}}','尚未'],['not json','有效 JSON'],
   ['{"tool":"native:other","arguments":{"file":"__DOCUMENT_SOURCE__"}}','未授权'],
   [`{"tool":"${choice.id}","arguments":{"file":"invented.pdf"}}`,'必须引用'],
   ['{"final":{"text":"x","extra":true}}','最终结果'],
  ]){const f=fixture(agentConfig);f.request.backend.generate=async()=>response!;await expect(f.run()).rejects.toThrow(error);expect(f.execute).not.toHaveBeenCalled()}
 })
 it('requires every source in a file array to be read before accepting final text',async()=>{
  const f=fixture(agentConfig);f.request.inputs.source=[{workflowFileId:'file-a'},{workflowFileId:'file-a'}];let step=0
  f.request.backend.generate=async()=>++step===1?JSON.stringify({tool:choice.id,arguments:{file:'__DOCUMENT_SOURCE_1__'}}):JSON.stringify({final:{text:'incomplete'}})
  await expect(f.run()).rejects.toThrow('全部文件');expect(f.execute).toHaveBeenCalledOnce()
 })
 it('validates document configuration modes and required execution capabilities',()=>{
  const workflow=makeWorkflow('w'),node=workflow.nodes[1]!;node.kind='document';node.config={source:'{{input.file}}',...agentConfig}
  expect(parseWorkflow(workflow).nodes[1]?.config.documentMode).toBe('agent')
  node.config={source:'x',documentMode:'agent'};expect(graphIssues(parseWorkflow(workflow),true).map(i=>i.message).join(' ')).toContain('能读取文件的工具')
  node.config={source:'x',documentMode:'tool'};expect(graphIssues(parseWorkflow(workflow),true).map(i=>i.message).join(' ')).toContain('请选择文档解析工具')
  node.config={source:'x',documentMode:'local',documentTextPath:'__proto__.text'};expect(()=>parseWorkflow(workflow)).toThrow()
  node.config={source:'x',documentMode:'unknown'} as unknown as NodeConfig;expect(()=>parseWorkflow(workflow)).toThrow()
 })
})

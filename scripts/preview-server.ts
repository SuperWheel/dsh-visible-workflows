import { createServer } from 'vite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { WorkflowTemplateLibrary } from '../src/host/template-library.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { parseWorkflowImportOptions } from '../src/shared/workflow-import.ts'
import { inspectSecretBoundary } from '../src/host/secret-boundary.ts'

// Preview uses the shipped UI, native theme and real persistent executor. Model
// calls and native conversation APIs are intentionally unavailable outside DSH.
const root = resolve(import.meta.dirname, '..')
const themeSource = readFileSync(resolve(root,'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),'utf8')
const theme = ['base','design_platform','focus','scrollbar'].map(name=>{
  const match=themeSource.match(new RegExp(`var ${name}_css_default = ("(?:[^"\\\\]|\\\\.)*");`))
  if(!match)throw new Error(`Native theme asset missing: ${name}`)
  return JSON.parse(match[1]!) as string
}).join('\n')
mkdirSync(resolve(root,'.cache/preview'),{recursive:true})
writeFileSync(resolve(root,'.cache/preview/native-theme.css'),theme)
const storage=new WorkflowStorage(resolve(root,'.cache/preview/state'))
const editorState=new WorkflowEditorState(storage)
const templates=new WorkflowTemplateLibrary(resolve(root,'.cache/preview/templates'))
const runtime=new WorkflowRuntime(storage,{async generate(){throw new Error('浏览器预览未连接模型，请在 DeepSeekHarness 中配置并执行模型节点。')}})
const workspaces=[{id:'preview-workspace',name:'MVP 测试工作区'}]
if(!storage.workflows().length)storage.save(makeWorkflow(workspaces[0]!.id,'本地文本处理示例',true),0)
const methods:Record<string,(...args:any[])=>unknown>={
  secretBoundary:()=>inspectSecretBoundary({get:()=>undefined}),
  list:(workspaceId:string)=>({workflows:storage.workflows(workspaceId),presets:storage.presets(),runs:storage.runs(workspaceId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)),workspaces}),
  get:(id:string)=>storage.get(id), save:(json:string,revision:number)=>storage.save(JSON.parse(json),revision),
  remove:(id:string,revision:number)=>storage.remove(id,revision), presets:()=>storage.presets(),
  savePreset:(json:string)=>storage.savePreset(JSON.parse(json)), deletePreset:(id:string)=>storage.deletePreset(id),models:()=>[],
  start:(id:string,json:string,sessionId?:string)=>runtime.start(id,JSON.parse(json),undefined,{sessionId}),answer:(id:string,json:string)=>runtime.answer(id,JSON.parse(json)),
  run:(id:string)=>storage.run(id),cancel:(id:string)=>runtime.cancel(id),
  stopNode:(_id:string,_executionId:string)=>{throw new Error('浏览器预览不支持停止原生子 Agent，请在 DeepSeekHarness 中操作。')},
  confirmRepairOutput:(id:string,executionId:string,attempts:number)=>runtime.confirmRepairOutput(id,executionId,attempts),
  pause:(id:string)=>runtime.pause(id),resume:(id:string)=>runtime.resume(id),
  recoveryPlan:(id:string,review?:unknown)=>runtime.recoveryPlan(id,review),
  recover:(id:string,sessionId?:string,digest?:string,review?:unknown)=>runtime.recover(id,'resume',sessionId,digest,review),rerun:(id:string,sessionId?:string)=>runtime.recover(id,'rerun',sessionId),
  proposals:(id:string)=>editorState.proposals(id),propose:(json:string,revision:number)=>editorState.propose(JSON.parse(json),revision),
  resolveProposal:(id:string,action:'accept'|'reject',revision:number)=>editorState.resolve(id,action,revision),
  drafts:(id:string,sessionId?:string)=>editorState.drafts(id,sessionId),saveDraft:(json:string,revision:number)=>editorState.saveDraft(JSON.parse(json),revision),removeDraft:(id:string,revision:number)=>editorState.removeDraft(id,revision),
  archived:(workspaceId?:string)=>storage.archived(workspaceId),restore:(id:string)=>storage.restore(id),
  previewImport:async(json:string,workspaceId:string,options:unknown={})=>(await prepareWorkflowImport(json,workspaceId,parseWorkflowImportOptions(options),{models:[],tools:[],workflows:storage.workflows(workspaceId),presets:storage.presets()},root)).preview,
  importPackage:async(json:string,workspaceId:string,options:unknown={})=>{const parsed=parseWorkflowImportOptions(options),value=await prepareWorkflowImport(json,workspaceId,parsed,{models:[],tools:[],workflows:storage.workflows(workspaceId),presets:storage.presets()},root);if(!value.preview.canImport||!value.workflow||!value.presets)throw new Error('依赖尚未完成映射，请在宿主中检查导入');return storage.importBundle(value.workflow,value.presets,parsed.overwrite)},
  archivedTemplates:()=>templates.archived(),restoreTemplate:(id:string,revision:number)=>templates.restore(id,revision),
  templates:()=>templates.list(),saveTemplate:(id:string,title:string)=>{const flow=storage.get(id);if(!flow)throw new Error('工作流不存在');return templates.save(flow,{title,presets:storage.presets()})},
  renameTemplate:(id:string,title:string,revision:number)=>templates.rename(id,title,revision),removeTemplate:(id:string,revision:number)=>templates.remove(id,revision),
  useTemplate:(id:string,workspaceId:string)=>{const imported=templates.instantiate(id,workspaceId);return storage.importBundle(imported.workflow,imported.presets)},
  tools:()=>[],importSwagger:()=>{throw new Error('浏览器预览不支持连接宿主工具，请在 DeepSeekHarness 中导入。')},
}
const port=Number(process.env.WORKFLOW_PREVIEW_PORT||5187)
const origin=`http://127.0.0.1:${port}`
const require=createRequire(resolve(root,'package.json'))
// The SDK declares its host-provided UI libraries as dev dependencies. Resolve
// them from this preview's own dependencies while leaving Desktop externals intact.
const nativeSource=readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-primitives'),'utf8')
const imports=[...nativeSource.matchAll(/^import .*? from "([^".][^"]+)"/gm)].map(m=>m[1]!)
const aliases=[...new Set(imports)].filter(name=>!name.startsWith('react')).map(name=>({find:new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`),replacement:require.resolve(name)}))
const server=await createServer({root,configFile:false,resolve:{dedupe:['react','react-dom'],alias:aliases},optimizeDeps:{entries:['src/preview/index.html'],force:true},server:{host:'127.0.0.1',port,strictPort:true},appType:'spa',
  plugins:[{name:'workflow-preview-api',configureServer(server){server.middlewares.use('/__workflow',async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store')
    try{
      if(req.method!=='POST'||req.headers['content-type']!=='application/json'||(req.headers.origin&&req.headers.origin!==origin))throw new Error('不允许的预览请求')
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>9_000_000)throw new Error('请求过大')}
      const request=JSON.parse(body)
      if(!Object.hasOwn(methods,request.method)||!Array.isArray(request.args))throw new Error('未知操作')
      const value=await methods[request.method]!(...request.args)
      res.end(JSON.stringify({value:value??null}))
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error instanceof Error?error.message:String(error)}))}
  })}}],
})
await server.listen()
console.log(`Workflow MVP preview: ${origin}/src/preview/index.html`)
async function close(){await server.close();await runtime.close();process.exit(0)}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close())

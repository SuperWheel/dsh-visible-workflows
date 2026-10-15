import { createServer } from 'vite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'
import { makeWorkflow } from '../src/shared/types.ts'

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
const runtime=new WorkflowRuntime(storage,{async generate(){throw new Error('浏览器预览未连接模型，请在 DeepSeekHarness 中配置并执行模型节点。')}})
const workspaces=[{id:'preview-workspace',name:'MVP 测试工作区'}]
if(!storage.workflows().length)storage.save(makeWorkflow(workspaces[0]!.id,'本地文本处理示例',true),0)
const methods:Record<string,(...args:any[])=>unknown>={
  list:(workspaceId:string)=>({workflows:storage.workflows(workspaceId),presets:storage.presets(),runs:storage.runs(workspaceId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)),workspaces}),
  get:(id:string)=>storage.get(id), save:(json:string,revision:number)=>storage.save(JSON.parse(json),revision),
  remove:(id:string,revision:number)=>storage.remove(id,revision), presets:()=>storage.presets(),
  savePreset:(json:string)=>storage.savePreset(JSON.parse(json)), deletePreset:(id:string)=>storage.deletePreset(id),models:()=>[],
  start:(id:string,json:string)=>runtime.start(id,JSON.parse(json)),answer:(id:string,json:string)=>runtime.answer(id,JSON.parse(json)),
  run:(id:string)=>storage.run(id),cancel:(id:string)=>runtime.cancel(id),
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
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw new Error('请求过大')}
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

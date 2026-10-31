import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutionAdapters, verifyRequiredFiles } from '../src/host/execution-adapters.ts'
import { ToolCatalog } from '../src/host/tool-catalog.ts'
import type { AdapterRequest } from '../src/host/runtime.ts'

const directories:string[]=[]
const temporary=()=>{const path=mkdtempSync(join(tmpdir(),'workflow-artifact-'));directories.push(path);return path}
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})
const signal=()=>new AbortController().signal

describe('actual artifact verification',()=>{
  it('accepts a real readable artifact, including an internal symlink',async()=>{
    const root=temporary();writeFileSync(join(root,'report.md'),'verified content');symlinkSync('report.md',join(root,'alias.md'))
    await expect(verifyRequiredFiles(root,['report.md','alias.md'],signal())).resolves.toBeUndefined()
  })
  it('rejects nonexistent output, directories, absolute paths and parent traversal',async()=>{
    const root=temporary()
    for(const path of ['missing.md','.',join(root,'file.md'),'../escape'])await expect(verifyRequiredFiles(root,[path],signal())).rejects.toThrow()
  })
  it('rejects a symlink to a readable file outside the workspace',async()=>{
    const root=temporary(),outside=temporary();writeFileSync(join(outside,'private.md'),'private');symlinkSync(join(outside,'private.md'),join(root,'report.md'))
    await expect(verifyRequiredFiles(root,['report.md'],signal())).rejects.toThrow('符号链接越出')
  })
  it('fails native node completion when its claimed file is absent, without rerunning its task',async()=>{
    const root=temporary(),catalog=new ToolCatalog({directory:root,workflows:()=>[],nativeTools:()=>[],executeNative:async()=>({}),runWorkflow:async()=>({}),http:async()=>({})})
    let nativeCalls=0
    const adapters=createExecutionAdapters({catalog,workspaceRoot:()=>root,nativeAgent:async()=>{nativeCalls++;return {text:'I wrote the file'}}})
    const request:AdapterRequest={node:{id:'n',number:'a-1',title:'artifact',kind:'agent',x:0,y:0,fixed:false,config:{verification:{requiredFiles:['report.md']}}},inputs:{},workspaceId:'w',runId:'r',signal:signal(),backend:{generate:async()=>''}}
    expect(await adapters.execute('agent',request)).toEqual({text:'I wrote the file'})
    await expect(adapters.verify!(request.node,request.workspaceId,request.signal)).rejects.toThrow('文件不存在')
    expect(nativeCalls).toBe(1)
  })
})

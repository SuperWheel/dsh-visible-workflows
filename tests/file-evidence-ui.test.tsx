import React, { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileVerificationConfig } from '../src/client/node-config.tsx'
import { ExecutionDetails } from '../src/client/execution-details.tsx'
import type { NodeConfig,NodeExecution } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Switch:'switch-mock',Tooltip:({children,label}:any)=><tooltip-mock label={label}>{children}</tooltip-mock>,Menu:({anchor}:any)=><>{anchor}</>,Modal:()=>null}))
vi.mock('../src/client/prompt-editor.tsx',()=>({PromptEditor:()=>null}))
vi.mock('../src/client/data-viewer.tsx',()=>({DataViewer:({title,value}:any)=><section data-title={title}>{JSON.stringify(value)}</section>}))
const renderers:ReactTestRenderer[]=[]
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount())})
function render(element:React.ReactElement){let renderer!:ReactTestRenderer;act(()=>{renderer=create(element)});renderers.push(renderer);return renderer}
describe('file evidence configuration and results',()=>{
  it('edits all three requirements independently, keeps trailing newlines usable and preserves other validators',()=>{
    let current:NodeConfig['verification']
    function Fixture(){const[value,setValue]=useState<NodeConfig['verification']>({requiredFiles:['out.txt'],minTextLength:20});current=value;return <FileVerificationConfig value={value} disabled={false} onChange={setValue}/>}
    const renderer=render(<Fixture/>),read=()=>renderer.root.findByProps({'aria-label':'必读资料'})
    act(()=>read().props.onChange({target:{value:' source.txt\n'}}));expect(read().props.value).toBe(' source.txt\n')
    act(()=>read().props.onChange({target:{value:'source.txt\nsecond.md\nsource.txt'}}))
    act(()=>renderer.root.findByProps({'aria-label':'必要文件变更'}).props.onChange({target:{value:'out.txt'}}))
    expect(current).toEqual({requiredFiles:['out.txt'],requiredReadFiles:['source.txt','second.md'],requiredChangedFiles:['out.txt'],minTextLength:20})
    act(()=>read().props.onChange({target:{value:''}}));expect(current?.requiredReadFiles).toBeUndefined();expect(current?.requiredFiles).toEqual(['out.txt'])
  })
  it('keeps protected node file requirements read-only and explains what each check proves',()=>{
    const renderer=render(<FileVerificationConfig value={{requiredReadFiles:['source.txt'],requiredChangedFiles:['out.txt']}} disabled onChange={()=>{}}/>),text=JSON.stringify(renderer.toJSON())
    expect(renderer.root.findAllByType('textarea').every(input=>input.props.disabled)).toBe(true)
    expect(text).toContain('完整成功读取回执');expect(text).toContain('不证明由哪个进程修改');expect(text).toContain('不表示 Agent 已读')
  })
  it('removes the empty verification object when its last requirement is cleared',()=>{
    const change=vi.fn(),renderer=render(<FileVerificationConfig value={{requiredFiles:['out.txt']}} disabled={false} onChange={change}/>)
    act(()=>renderer.root.findByProps({'aria-label':'必需文件产物'}).props.onChange({target:{value:''}}))
    expect(change).toHaveBeenCalledExactlyOnceWith(undefined)
  })
  it('shows unverified and hash evidence without leaking extra file content or blessing a reused result',()=>{
    const hash='a'.repeat(64),before={version:1 as const,workspaceRootDigest:'b'.repeat(64),files:{'source.txt':{path:'source.txt',status:'present' as const,sha256:hash,size:9,content:'must-not-render'}}}
    const execution:NodeExecution={nodeId:'node',number:'a-2',title:'Agent',status:'failed',verification:{status:'unverified',reasons:['缺少可信读取回执']},reusedFromRunId:'old-run',fileEvidence:{before,after:before,reads:[{path:'source.txt',sha256:hash,taskId:'child-id',tools:[],calls:0,status:'unverified',reason:'未取得成功回执'}]}}
    const renderer=render(<ExecutionDetails execution={execution}/>),text=JSON.stringify(renderer.toJSON())
    expect(text).toContain('结果验证：');expect(text).toContain('未验证');expect(text).toContain(hash);expect(text).toContain('child-id')
    expect(text).not.toContain('must-not-render');expect(text).not.toContain('经过核验的历史结果')
  })
})

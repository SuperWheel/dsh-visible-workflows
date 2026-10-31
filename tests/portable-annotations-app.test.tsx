import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowApp, type AnnotationBridge, type WorkflowNavigation } from '../src/client/app.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type Workflow, type WorkflowAPI } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:'button',Input:'input',Tooltip:({children}:any)=><>{children}</>,Menu:({anchor}:any)=><>{anchor}</>,Modal:({children}:any)=><>{children}</>}))
vi.mock('../src/client/canvas.tsx',()=>({Canvas:(props:any)=><canvas-mock {...props}/>}))
vi.mock('../src/client/editor-heading.tsx',()=>({EditorHeading:(props:any)=><heading-mock {...props}/>}))
vi.mock('../src/client/annotation-editor.tsx',()=>({AnnotationEditor:(props:any)=><annotation-editor-mock {...props}/>}))
const stores:WorkflowStore[]=[],uis:ReactTestRenderer[]=[]
afterEach(()=>{for(const ui of uis.splice(0))act(()=>ui.unmount());for(const store of stores.splice(0))store.dispose()})
function fixture(){
  const source={...makeWorkflow('workspace','来源流程',true),id:'source',revision:1}
  source.editor={annotations:[{id:'shared-note-id',number:1,text:'导入的说明',nodeIds:[source.nodes[1]!.id],position:{x:100,y:200,scopePath:[]}}]}
  // Matching node and annotation IDs across different workflows are legal.
  const other:Workflow={...structuredClone(source),id:'other',title:'另一流程',editor:{annotations:[{...source.editor.annotations![0]!,text:'另一流程的说明'}]}}
  const saved=new Map([[source.id,structuredClone(source)],[other.id,structuredClone(other)]])
  const api={get:vi.fn(async(id:string)=>structuredClone(saved.get(id)!)),save:vi.fn(async(raw:string,revision:number)=>{const flow={...JSON.parse(raw),revision:revision+1};saved.set(flow.id,flow);return flow}),inspectReadiness:async(flow:Workflow)=>({workflowId:flow.id,revision:flow.revision,canRun:true,issues:[]})} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow:source,page:'canvas',sessionId:'session',loading:false,library:{workflows:[source,other],runs:[],presets:[],workspaces:[]}})
  const chat:AnnotationBridge={stageAnnotation:vi.fn(async()=>{}),deleteAnnotation:vi.fn(async()=>{}),insertGenerateRequest:vi.fn(async()=>true),insertWorkflow:vi.fn(async()=>{}),getAnnotations:vi.fn(()=>[]),subscribe:()=>()=>{}}
  const navigation:WorkflowNavigation={getSessionId:()=> 'session',sessions:()=>[{id:'session',title:'当前对话'}],openChat:vi.fn(async()=>{}),openSettings:()=>{},toFull:()=>{},toSide:()=>{}}
  let ui!:ReactTestRenderer;act(()=>{ui=create(<WorkflowApp store={store} mode="side" navigation={navigation} chat={chat}/>)});uis.push(ui)
  const canvas=()=>ui.root.findByType('canvas-mock' as never),editor=()=>ui.root.findByType('annotation-editor-mock' as never)
  const openNote=()=>act(()=>canvas().props.onEditAnnotation('shared-note-id'))
  return {source,other,saved,api,store,chat,navigation,ui,canvas,editor,openNote}
}

describe('portable annotations inside the existing canvas',()=>{
  it('explicitly discards a new annotation without touching saved annotations or chat',async()=>{
    const f=fixture(),saved=structuredClone(f.store.getSnapshot().workflow)
    act(()=>f.store.update({selected:[f.source.nodes[1]!.id]}))
    act(()=>f.canvas().props.onAnnotate({position:{x:140,y:180,scopePath:[]}}))
    act(()=>f.editor().props.onDraftChange('new','尚未保存的新注释',[f.source.nodes[1]!.id]))
    expect(f.canvas().props.pendingAnnotation?.text).toBe('尚未保存的新注释')
    await act(async()=>f.editor().props.onDiscard())
    expect(f.store.getSnapshot().annotationDraft).toBeUndefined()
    expect(f.canvas().props.pendingAnnotation).toBeUndefined()
    expect(f.store.getSnapshot().workflow).toEqual(saved)
    expect(f.api.save).not.toHaveBeenCalled()
    expect(f.chat.deleteAnnotation).not.toHaveBeenCalled()
    expect(f.chat.stageAnnotation).not.toHaveBeenCalled()
  })
  it('a stale new-annotation discard cannot clear a different workflow draft',async()=>{
    const f=fixture()
    act(()=>f.canvas().props.onAnnotate({position:{x:140,y:180,scopePath:[]}}))
    const discard=f.editor().props.onDiscard
    await act(async()=>f.store.open('other'))
    act(()=>f.store.update({annotationDraft:{text:'新流程的草稿',nodeIds:[f.other.nodes[1]!.id]}}))
    expect(discard).toThrow('工作流或注释已变化')
    expect(f.store.getSnapshot().annotationDraft?.text).toBe('新流程的草稿')
    expect(f.chat.deleteAnnotation).not.toHaveBeenCalled()
  })
  it('shows imported annotations without staging chat and deletes them only from their own workflow',async()=>{
    const f=fixture();expect(f.canvas().props.annotations).toMatchObject([{text:'导入的说明'}]);expect(f.chat.stageAnnotation).not.toHaveBeenCalled()
    f.openNote();await act(async()=>f.editor().props.onDelete('shared-note-id'));await f.store.flush()
    expect(f.store.getSnapshot().workflow?.editor?.annotations).toEqual([]);expect(f.chat.deleteAnnotation).not.toHaveBeenCalled();expect(f.chat.stageAnnotation).not.toHaveBeenCalled()
    expect(f.saved.get('other')?.editor?.annotations?.[0]?.text).toBe('另一流程的说明')
  })
  it('stages a new native chat annotation only after explicit submission and removes the portable copy',async()=>{
    const f=fixture();f.openNote()
    await act(async()=>f.editor().props.onSave('shared-note-id','明确提交的修改',[f.source.nodes[1]!.id]))
    expect(f.chat.stageAnnotation).toHaveBeenCalledExactlyOnceWith('session',expect.objectContaining({id:'source'}),[f.source.nodes[1]!.id],'明确提交的修改',undefined,{x:100,y:200,scopePath:[]})
    expect(f.store.getSnapshot().workflow?.editor?.annotations).toEqual([]);expect(f.store.getSnapshot().annotationDraft).toBeUndefined()
  })
  it('keeps same-named nodes and same annotation IDs isolated when switching workflows',async()=>{
    const f=fixture();f.openNote();await act(async()=>f.store.open('other'))
    expect(f.canvas().props.annotations).toMatchObject([{text:'另一流程的说明',nodeIds:[f.other.nodes[1]!.id]}]);expect(f.store.getSnapshot().annotationDraft).toBeUndefined()
    expect(f.chat.getAnnotations).toHaveBeenLastCalledWith('other','session');expect(f.chat.stageAnnotation).not.toHaveBeenCalled();expect(f.chat.deleteAnnotation).not.toHaveBeenCalled()
  })
  it('does not stage old node references after the canvas changes while opening the conversation',async()=>{
    const f=fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve)
    f.navigation.openChat=vi.fn(async()=>{entered();await new Promise<void>(resolve=>release=resolve)})
    act(()=>f.ui.update(<WorkflowApp store={f.store} mode="side" navigation={f.navigation} chat={f.chat}/>));f.openNote()
    let submitting!:Promise<void>;act(()=>{submitting=f.editor().props.onSave('shared-note-id','旧流程提交',[f.source.nodes[1]!.id])});await started
    await act(async()=>f.store.open('other'));act(()=>f.store.update({annotationDraft:{id:'new-draft',text:'不能清除的新草稿',nodeIds:[f.other.nodes[1]!.id]}}))
    await act(async()=>{release();await expect(submitting).rejects.toThrow('工作流或批注已变化')})
    expect(f.chat.stageAnnotation).not.toHaveBeenCalled();expect(f.store.getSnapshot().annotationDraft?.text).toBe('不能清除的新草稿')
  })
  it('finishes an in-flight successful submission against the original workflow without deleting the new canvas annotation',async()=>{
    const f=fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve)
    f.chat.stageAnnotation=vi.fn(async()=>{entered();await new Promise<void>(resolve=>release=resolve)})
    f.openNote();let submitting!:Promise<void>;act(()=>{submitting=f.editor().props.onSave('shared-note-id','来源提交',[f.source.nodes[1]!.id])});await started
    await act(async()=>f.store.open('other'));act(()=>f.store.update({annotationDraft:{id:'shared-note-id',text:'新流程中刚写的草稿',nodeIds:[f.other.nodes[1]!.id]}}))
    await act(async()=>{release();await submitting})
    expect(f.saved.get('source')?.editor?.annotations).toEqual([]);expect(f.store.getSnapshot().workflow?.editor?.annotations?.[0]?.text).toBe('另一流程的说明')
    expect(f.store.getSnapshot().annotationDraft?.text).toBe('新流程中刚写的草稿');expect(f.chat.deleteAnnotation).not.toHaveBeenCalled()
  })
})

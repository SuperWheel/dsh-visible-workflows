import {afterEach,describe,expect,it,vi} from 'vitest'
import { WorkflowViews } from '../src/client/navigation.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'
const active:WorkflowViews[]=[]
afterEach(()=>{active.forEach(v=>v.dispose());active.length=0})
function setup(){
  const flow={...makeWorkflow('w','A',true),id:'a',revision:1}
  const api={list:async()=>({workflows:[flow],presets:[],runs:[],workspaces:[]}),models:async()=>[],get:async()=>flow,save:async(raw:string)=>({...JSON.parse(raw),revision:2})} as unknown as WorkflowAPI
  const views=new WorkflowViews(api);active.push(views);return{views,flow,api}
}
describe('workflow presentation and session navigation',()=>{
  it('expands and restores the same editor with viewport, panel, draft and undo intact',async()=>{
    const{views,flow}=setup(),editor=views.session('conversation-a');await editor.open(flow.id)
    editor.update({viewport:{x:-120,y:85,scale:.65},selected:[flow.nodes[1]!.id],configId:flow.nodes[1]!.id,logs:true,annotationDraft:{text:'keep',nodeIds:[flow.nodes[1]!.id]},generateDraft:'需求'})
    editor.edit({...flow,title:'Changed'});await editor.flush()
    const before=editor.getSnapshot();views.expand('conversation-a')
    expect(views.getSnapshot()).toEqual({store:editor,originSessionId:'conversation-a'})
    expect(views.session('conversation-a').getSnapshot()).toBe(before)
    expect(before.undo).toHaveLength(1)
    expect(views.session('conversation-b').getSnapshot().workflow).toBeUndefined()
  })
  it('captures an uncommitted animation frame before expanding',async()=>{
    const{views,flow}=setup(),editor=views.session('a');await editor.open(flow.id)
    editor.registerViewport(()=>({x:18,y:29,scale:.9}),flow.id);views.expand('a')
    expect(views.getSnapshot().store.getSnapshot().viewport).toEqual({x:18,y:29,scale:.9})
  })
  it('manager entry never overwrites the source conversation canvas',async()=>{
    const{views,flow}=setup(),editor=views.session('a');await editor.open(flow.id);views.expand('a');views.management()
    expect(views.getSnapshot().originSessionId).toBeUndefined();expect(views.getSnapshot().store.getSnapshot().page).toBe('library')
    expect(editor.getSnapshot().page).toBe('canvas')
  })
  it('explicit association preserves the original store, then isolates the next management entry',async()=>{
    const{views,flow}=setup(),manager=views.getSnapshot().store;await manager.open(flow.id)
    manager.update({generateDraft:'do not send',viewport:{x:100,y:200,scale:.5}})
    await views.attach(manager,'chosen')
    expect(views.session('chosen')).toBe(manager);expect(manager.getSnapshot().sessionId).toBe('chosen')
    views.management();expect(views.getSnapshot().store).not.toBe(manager);expect(manager.getSnapshot().generateDraft).toBe('do not send')
    await views.getSnapshot().store.open(flow.id);expect(views.associatedSession(views.getSnapshot().store)).toBe('chosen')
  })
  it('background completion only creates a notification in its exact source session',async()=>{
    const{views,flow}=setup(),main=views.getSnapshot();views.session('foreground')
    await views.generated(flow.id,'background')
    expect(views.getSnapshot()).toBe(main)
    expect(views.session('foreground').getSnapshot().pendingWorkflow).toBeUndefined()
    expect(views.session('background').getSnapshot().pendingWorkflow?.id).toBe(flow.id)
    expect(views.session('background').getSnapshot().workflow).toBeUndefined()
  })
  it('save failure prevents association and preserves the draft and original session',async()=>{
    const{views,flow,api}=setup(),manager=views.getSnapshot().store;await manager.open(flow.id);manager.edit({...flow,title:'unsaved'});manager.update({generateDraft:'keep'})
    api.save=vi.fn(async()=>{throw new Error('save failed')})
    await expect(views.attach(manager,'target')).rejects.toThrow('save failed')
    expect(manager.getSnapshot().sessionId).toBeUndefined();expect(manager.getSnapshot().generateDraft).toBe('keep')
  })
})

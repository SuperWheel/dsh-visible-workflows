import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWorkflow, type CanvasNote } from '../src/shared/types.ts'
import { arrangeAttachedNotes, moveAttachedNotes, noteColor, noteSize, remapNoteAnchors } from '../src/client/notes.ts'
import { newNode, nodeSize } from '../src/client/nodes.ts'
import { assertGraph, parseWorkflow } from '../src/host/validation.ts'
import { WorkflowStorage } from '../src/host/storage.ts'

const temporary:string[]=[]
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true})})
const note=(patch:Partial<CanvasNote>={}):CanvasNote=>({id:'note-1',text:'流程说明',x:60,y:300,...patch})
describe('persistent canvas notes',()=>{
  it('opens legacy notes without adding required fields or changing their content',()=>{
    const flow=makeWorkflow('workspace');flow.notes=[note()]
    const parsed=parseWorkflow(flow)
    expect(parsed.notes).toEqual(flow.notes)
    expect(noteSize(parsed.notes[0]!)).toEqual({width:280,height:180});expect(noteColor(parsed.notes[0]!)).toBe('yellow')
    expect(()=>assertGraph(parsed)).not.toThrow()
  })
  it('follows stable anchor IDs by their delta, including after manually changing note position',()=>{
    const node=newNode('template',100,100),original=note({anchorNodeId:node.id}),free=note({id:'free',x:0,y:0})
    const moved={...node,x:150,y:80,number:'b-8'},first=moveAttachedNotes([original,free],[node],[moved])
    expect(first[0]).toMatchObject({x:110,y:280,anchorNodeId:node.id});expect(first[1]).toBe(free)
    const manual={...first[0]!,x:500,y:650},again={...moved,x:200,y:110}
    expect(moveAttachedNotes([manual],[moved],[again])[0]).toMatchObject({x:550,y:680,anchorNodeId:node.id})
    expect(original).toMatchObject({x:60,y:300})
  })
  it('detaches a deleted anchor without deleting or moving the note',()=>{
    const node=newNode('template'),original=note({anchorNodeId:node.id})
    expect(moveAttachedNotes([original],[node],[])).toEqual([note()])
    const flow=makeWorkflow('workspace');flow.notes=[original]
    expect(parseWorkflow(flow).notes).toEqual([note()])
    expect(()=>assertGraph(flow)).toThrow('当前画布不存在')
  })
  it('does not connect a top-level note to an invisible child in a container',()=>{
    const flow=makeWorkflow('workspace'),container=newNode('iteration');flow.nodes.push(container)
    flow.notes=[note({anchorNodeId:container.config.body!.nodes[0]!.id})]
    expect(parseWorkflow(flow).notes[0]).not.toHaveProperty('anchorNodeId')
  })
  it.each([{width:159},{width:1201},{height:99},{height:901},{width:NaN},{height:Infinity},{color:'red'},{anchorNodeId:'../outside'}])('rejects unsupported persisted note attributes: %j',patch=>{
    const flow=makeWorkflow('workspace');flow.notes=[{...note(),...patch} as CanvasNote]
    expect(()=>parseWorkflow(flow)).toThrow()
  })
  it('rejects duplicate note identities without confusing an attachment with an executable edge',()=>{
    const flow=makeWorkflow('workspace');flow.notes=[note({anchorNodeId:flow.nodes[0]!.id}),note()]
    expect(()=>assertGraph(parseWorkflow(flow))).toThrow('便签身份重复')
    flow.notes.pop();const count=flow.edges.length
    expect(()=>assertGraph(parseWorkflow(flow),true)).not.toThrow();expect(flow.edges).toHaveLength(count)
  })
  it('arranges several attached notes below their anchor without overlapping nodes or free notes',()=>{
    const node=newNode('iteration',0,0),free=note({id:'free',x:0,y:276}),first=note({anchorNodeId:node.id}),second=note({id:'second',width:400,height:220,anchorNodeId:node.id})
    const result=arrangeAttachedNotes([free,first,second],[node]),rects=[{...node,...nodeSize(node)},...result.map(n=>({...n,...noteSize(n)}))]
    expect(result[0]).toBe(free);expect(result[1]!.anchorNodeId).toBe(node.id)
    for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
      const a=rects[i]!,b=rects[j]!
      expect(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y).toBe(false)
    }
  })
  it('remaps only copied anchors, preserving absolute position, dimensions and color',()=>{
    const original=note({anchorNodeId:'old-node',width:400,height:240,color:'purple'})
    expect(remapNoteAnchors([original],new Map([['old-node','copied-node']]))[0]).toEqual({...original,anchorNodeId:'copied-node'})
    expect(remapNoteAnchors([original],new Map())[0]).not.toHaveProperty('anchorNodeId')
    expect(original.anchorNodeId).toBe('old-node')
  })
  it('persists note appearance and attachment through saving and reopening storage',()=>{
    const path=mkdtempSync(join(tmpdir(),'workflow-notes-'));temporary.push(path)
    const storage=new WorkflowStorage(path),flow=makeWorkflow('workspace');flow.notes=[note({width:420,height:240,color:'green',anchorNodeId:flow.nodes[0]!.id})]
    const saved=storage.save(flow,0);storage.close()
    const reopened=new WorkflowStorage(path)
    try{expect(reopened.get(saved.id).notes).toEqual(flow.notes)}finally{reopened.close()}
  })
})

import { describe, expect, it } from 'vitest'
import { canvasAnnotations, copiedEditor, reconcileEditorReferences, withoutPortableAnnotation } from '../src/client/portable-annotations.ts'
import { copyNodes } from '../src/client/copy.ts'
import { newNode } from '../src/client/nodes.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'

describe('imported annotations stay on the original canvas',()=>{
  it('copies nested annotation references and scope paths to fresh node identities without changing world coordinates',()=>{
    const source=makeWorkflow('ws'),container=newNode('iteration'),child=container.config.body!.nodes[1]!
    source.nodes.push(container);source.editor={viewport:{x:123,y:-20,scale:.75},scopePath:[container.id],annotations:[{id:'copy-note',number:1,nodeIds:[child.id],text:'内部批注',position:{x:-50.5,y:130,scopePath:[container.id]}}]}
    const graph=copyNodes(source),target={...structuredClone(source),id:'copy-workflow',...graph};target.editor=copiedEditor(source,target)
    const newContainer=target.nodes.at(-1)!,newChild=newContainer.config.body!.nodes[1]!
    expect(target.editor?.scopePath).toEqual([newContainer.id]);expect(target.editor?.viewport).toEqual(source.editor.viewport)
    expect(target.editor?.annotations?.[0]).toMatchObject({nodeIds:[newChild.id],position:{x:-50.5,y:130,scopePath:[newContainer.id]}})
    expect(target.editor?.annotations?.[0]?.id).not.toBe('copy-note');expect(source.editor.annotations?.[0]?.nodeIds).toEqual([child.id]);expect(()=>parseWorkflow(target)).not.toThrow()
  })
  it('shows imported annotations without a chat and appends session annotations with unique visible ordinals',()=>{
    const flow=makeWorkflow('ws');flow.editor={annotations:[{id:'portable',number:7,nodeIds:[flow.nodes[0]!.id],text:'导入说明',position:{x:123,y:-45,scopePath:[]}}]}
    expect(canvasAnnotations(flow,[])).toMatchObject([{id:'portable',number:1,text:'导入说明',position:{x:123,y:-45}}])
    expect(canvasAnnotations(flow,[{id:'session',number:1,nodeIds:[flow.nodes[0]!.id],text:'本次要求'}]).map(a=>a.number)).toEqual([1,2])
    expect(withoutPortableAnnotation(flow,'portable').editor!.annotations).toEqual([])
    expect(flow.editor.annotations).toHaveLength(1)
  })
  it('preserves explanation text and valid references after deleting nodes',()=>{
    const flow=makeWorkflow('ws'),gone=flow.nodes[1]!.id
    flow.editor={scopePath:[],annotations:[{id:'portable',number:1,nodeIds:[flow.nodes[0]!.id,gone],text:'保留说明',position:{x:1,y:2,scopePath:[]}}]}
    flow.nodes=flow.nodes.filter(n=>n.id!==gone);flow.edges=[]
    const next=reconcileEditorReferences(flow)
    expect(next.editor!.annotations![0]).toMatchObject({nodeIds:[flow.nodes[0]!.id],text:'保留说明',position:{x:1,y:2}})
    expect(()=>parseWorkflow(next)).not.toThrow()
  })
})

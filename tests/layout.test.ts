import { describe, expect, it } from 'vitest'
import { arrangeNodes, boundsOf, fitView, overlaps, placeWithoutOverlap } from '../src/client/layout.ts'
import { branchTop, newNode, nodePorts, nodeSize, portY } from '../src/client/nodes.ts'

describe('mixed-size canvas layout',()=>{
  it('separates a container and tall branches without excessive fixed-width columns',()=>{
    const input=newNode('input'),container=newNode('iteration'),branch=newNode('if',0,0,{cases:Array.from({length:15},(_,i)=>({id:`case${i}`,logic:'and',conditions:[]}))}),output=newNode('output')
    const graph={nodes:[input,container,branch,output],edges:[{id:'a',source:input.id,target:container.id},{id:'b',source:input.id,target:branch.id},{id:'c',source:container.id,target:output.id},{id:'d',source:branch.id,target:output.id}]}
    const result=arrangeNodes(graph)
    for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++)expect(overlaps({...result[i]!,...nodeSize(result[i]!)},{...result[j]!,...nodeSize(result[j]!)},32)).toBe(false)
    expect(result[1]!.x-result[0]!.x).toBe(256+80)
    expect(result[3]!.x-result[1]!.x).toBe(480+80)
    expect(graph.nodes[0]!.x).toBe(90)
  })
  it('preserves copied subgraph spacing while avoiding occupied nodes',()=>{
    const a=newNode('iteration',100,100),b=newNode('output',660,100),copy=[{...a,id:'copy-a'},{...b,id:'copy-b'}]
    const placed=placeWithoutOverlap(copy,[a,b],{x:140,y:140})
    expect(placed[1]!.x-placed[0]!.x).toBe(b.x-a.x)
    for(const p of placed)for(const original of [a,b])expect(overlaps({...p,...nodeSize(p)},{...original,...nodeSize(original)},32)).toBe(false)
  })
  it('keeps classifier branch ports below the model strip and preview',()=>{
    const node=newNode('classifier'),ports=nodePorts(node)
    expect(branchTop(node)).toBeGreaterThan(branchTop(newNode('if')))
    for(const port of ports){expect(portY(node,port.id)).toBeGreaterThan(branchTop(node));expect(portY(node,port.id)).toBeLessThan(nodeSize(node).height)}
  })
  it('fits content with room for floating actions and returns valid transforms for empty graphs',()=>{
    const nodes=arrangeNodes({nodes:[newNode('iteration'),newNode('human')],edges:[]}),box=boundsOf(nodes),view=fitView(nodes,760,700)
    expect(box.width*view.scale).toBeLessThanOrEqual(760-96)
    expect(box.height*view.scale).toBeLessThanOrEqual(700-176)
    expect(fitView([],320,500)).toEqual({x:48,y:80,scale:1})
  })
  it('terminates for a malformed cyclic draft without moving node identities',()=>{
    const a=newNode('template'),b=newNode('template'),result=arrangeNodes({nodes:[a,b],edges:[{id:'ab',source:a.id,target:b.id},{id:'ba',source:b.id,target:a.id}]})
    expect(result.map(n=>n.id)).toEqual([a.id,b.id]);expect(result[0]!.x).not.toBe(result[1]!.x)
  })
})

import { describe,it,expect } from 'vitest'
import { revealNode } from '../src/client/inspector-viewport.ts'
import { newNode,nodeSize } from '../src/client/nodes.ts'

describe('floating inspector visibility',()=>{
  it('does not disturb a fully visible node',()=>{
    expect(revealNode(newNode('template',100,120),{x:0,y:0,scale:1},1000,700,360,60)).toBeUndefined()
  })
  it('centers a covered node within the exposed canvas without changing zoom',()=>{
    const node=newNode('template',800,140),view=revealNode(node,{x:0,y:0,scale:.75},1000,700,360,60)!
    expect(view.scale).toBe(.75)
    expect(view.x+(node.x+nodeSize(node).width/2)*view.scale).toBe((60+628)/2)
    expect(view.y+(node.y+nodeSize(node).height/2)*view.scale).toBe((60+636)/2)
  })
  it('keeps finite geometry on a narrow sidebar and for large container nodes',()=>{
    const node=newNode('loop',10,100),view=revealNode(node,{x:0,y:0,scale:.75},480,450,360,96)!
    expect(Number.isFinite(view.x)&&Number.isFinite(view.y)).toBe(true)
    expect(view.scale).toBe(.75)
    expect(view.x+(node.x+nodeSize(node).width/2)*view.scale).toBeLessThanOrEqual(120)
  })
})

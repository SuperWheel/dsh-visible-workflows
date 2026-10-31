import { describe, expect, it } from 'vitest'
import { legacyAnnotationPosition } from '../src/client/annotation-fallback.ts'
import { newNode, nodeSize } from '../src/client/nodes.ts'
import type { NodeGraph } from '../src/shared/types.ts'

function fixture(){
  const root=newNode('template',80,120),outer=newNode('iteration',400,100),inner=newNode('loop',60,90),child=newNode('llm',125,175)
  outer.id='outer';inner.id='inner';child.id='deep-child';root.id='root'
  inner.config.body={nodes:[child],edges:[]};outer.config.body={nodes:[inner],edges:[]}
  const workflow:NodeGraph={nodes:[root,outer],edges:[]}
  return {workflow,root,outer,inner,child}
}
describe('旧注释全流程唯一fallback点',()=>{
  it('按引用顺序选第一个仍存在节点，不按遍历顺序或当前scope选择',()=>{
    const{workflow,root,child}=fixture()
    expect(legacyAnnotationPosition(workflow,[child.id,root.id])).toEqual({x:child.x+nodeSize(child).width,y:child.y,scopePath:['outer','inner']})
    expect(legacyAnnotationPosition(workflow,[root.id,child.id])).toEqual({x:root.x+nodeSize(root).width,y:root.y,scopePath:[]})
  })
  it('已删除引用跳过，后续深层引用仍可定位到其原局部坐标',()=>{
    const{workflow,child}=fixture()
    expect(legacyAnnotationPosition(workflow,['deleted',child.id])).toEqual({x:381,y:175,scopePath:['outer','inner']})
  })
  it('引用容器本身使用其所在父scope及容器实际宽度',()=>{
    const{workflow,inner,child}=fixture()
    expect(legacyAnnotationPosition(workflow,[inner.id,child.id])).toEqual({x:inner.x+nodeSize(inner).width,y:inner.y,scopePath:['outer']})
  })
  it('空引用或全部失效时不编造点位',()=>{
    const{workflow}=fixture()
    expect(legacyAnnotationPosition(workflow,[])).toBeUndefined()
    expect(legacyAnnotationPosition(workflow,['removed'])).toBeUndefined()
  })
  it('仅派生显示坐标，不修改workflow或引用数组，返回scope也不共享',()=>{
    const{workflow,child}=fixture(),before=structuredClone(workflow),ids=[child.id]
    const position=legacyAnnotationPosition(workflow,ids)!
    position.scopePath.push('external-change');position.x=999
    expect(workflow).toEqual(before);expect(ids).toEqual([child.id])
    expect(legacyAnnotationPosition(workflow,ids)?.scopePath).toEqual(['outer','inner'])
  })
})

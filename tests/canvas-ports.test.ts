import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Canvas } from '../src/client/canvas.tsx'
import { newNode } from '../src/client/nodes.ts'
import { makeWorkflow, type WorkflowAPI, type WorkflowNode } from '../src/shared/types.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({
  Button:'button',Input:'input',Menu:()=>null,Modal:()=>null,
  Tooltip:({children}:{children:React.ReactNode})=>children,
}))
vi.mock('../src/client/mini-map.tsx',()=>({MiniMap:()=>null}))

const renderers:ReactTestRenderer[]=[]
beforeEach(()=>{
  vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1))
  vi.stubGlobal('cancelAnimationFrame',vi.fn())
  vi.stubGlobal('ResizeObserver',class{constructor(private readonly callback:()=>void){}observe(){this.callback()}disconnect(){}})
})
afterEach(()=>{for(const renderer of renderers.splice(0))act(()=>renderer.unmount());vi.unstubAllGlobals()})

function mount(nodes:WorkflowNode[],overrides:Partial<React.ComponentProps<typeof Canvas>>={}){
  const onEdit=vi.fn(),onSelect=vi.fn(),onConfigure=vi.fn()
  let props:React.ComponentProps<typeof Canvas>={
    workflow:{...makeWorkflow('workspace','连接点验收'),nodes,edges:[],notes:[]},api:{} as WorkflowAPI,
    selected:[],disabled:false,canUndo:false,canRedo:false,annotations:[],viewport:{x:0,y:0,scale:1},
    onEdit,onSelect,onConfigure,onViewport:vi.fn(),onEnter:vi.fn(),onAnnotate:vi.fn(),onEditAnnotation:vi.fn(),
    onUndo:vi.fn(),onRedo:vi.fn(),onRunDetails:vi.fn(),...overrides,
  }
  const surface={clientWidth:600,clientHeight:500,getBoundingClientRect:()=>({left:0,top:0,width:600,height:500}),addEventListener:vi.fn(),removeEventListener:vi.fn()}
  let renderer!:ReactTestRenderer
  act(()=>{renderer=create(React.createElement(Canvas,props),{createNodeMock:node=>node.props['aria-label']==='工作流画布'?surface:null})});renderers.push(renderer)
  const ports=()=>renderer.root.findAllByType('button').filter(button=>button.props.className?.split(' ').includes('vdw-port'))
  return{renderer,onEdit,onSelect,onConfigure,ports,
    button:(label:string)=>renderer.root.findByProps({'aria-label':label}),
    node:(node:WorkflowNode)=>renderer.root.findByProps({'aria-label':`${node.number} ${node.title}`}),
    update:(patch:Partial<React.ComponentProps<typeof Canvas>>)=>{props={...props,...patch};act(()=>renderer.update(React.createElement(Canvas,props)))},
    targets:()=>ports().filter(port=>port.props.className.split(' ').includes('is-target')),
  }
}

describe('Canvas connection ports',()=>{
  it('renders only valid incoming and outgoing controls for start, ordinary, output and loop-exit nodes',()=>{
    const nodes=[newNode('input',0,80),newNode('template',270,80),newNode('output',0,240),newNode('exit_loop',270,240)],fixture=mount(nodes)
    expect(fixture.node(nodes[0]!).findAllByType('button').map(button=>button.props['aria-label'])).toEqual(['从 用户输入连接'])
    expect(fixture.node(nodes[1]!).findAllByType('button').map(button=>button.props['aria-label'])).toEqual(['连接至 模板转换','从 模板转换连接'])
    expect(fixture.node(nodes[2]!).findAllByType('button').map(button=>button.props['aria-label'])).toEqual(['连接至 输出'])
    expect(fixture.node(nodes[3]!).findAllByType('button').map(button=>button.props['aria-label'])).toEqual(['连接至 退出循环'])
    expect(fixture.targets()).toHaveLength(0)
  })
  it('keeps all multi-selected node ports under their selected card while preserving disabled execution controls',()=>{
    const first=newNode('template',0,80),second={...newNode('template',300,80),number:'u-2'},fixture=mount([first,second])
    fixture.update({selected:[first.id,second.id]})
    for(const node of [first,second]){
      expect(fixture.node(node).props.className).toContain('is-selected')
      expect(fixture.node(node).props['aria-pressed']).toBe(true)
      expect(fixture.node(node).findAllByType('button')).toHaveLength(2)
    }
    fixture.update({selected:[second.id],disabled:true})
    expect(fixture.node(first).props['aria-pressed']).toBe(false)
    expect(fixture.node(second).props['aria-pressed']).toBe(true)
    expect(fixture.ports().every(port=>port.props.disabled)).toBe(true)
    expect(fixture.onEdit).not.toHaveBeenCalled()
  })
  it('arms only the chosen branch output, retains its stable branch ID and adds one real edge',()=>{
    const source=newNode('if',0,80,{cases:[{id:'case-a',logic:'and',conditions:[]},{id:'case-b',logic:'and',conditions:[]}]}),target=newNode('template',310,80),fixture=mount([source,target])
    const branchPorts=fixture.node(source).findAllByType('button').filter(button=>button.props.className.includes('vdw-port-out'))
    expect(branchPorts.map(port=>port.props.title)).toEqual(['IF','ELIF','ELSE'])
    expect(new Set(branchPorts.map(port=>port.props.style.top)).size).toBe(3)
    act(()=>fixture.button('从 条件分支 ELIF分支连接').props.onClick())
    expect(fixture.targets().filter(port=>port.props.className.includes('vdw-port-out'))).toHaveLength(1)
    expect(fixture.targets().filter(port=>port.props.className.includes('vdw-port-in'))).toHaveLength(2)
    act(()=>fixture.button('连接至 条件分支').props.onClick())
    expect(fixture.onEdit).not.toHaveBeenCalled()
    act(()=>fixture.button('连接至 模板转换').props.onClick())
    expect(fixture.onEdit).toHaveBeenCalledOnce()
    expect(fixture.onEdit.mock.calls[0]![0].edges).toEqual([{id:expect.any(String),source:source.id,target:target.id,port:'case-b'}])
    expect(fixture.targets()).toHaveLength(0)
    expect(fixture.onConfigure).not.toHaveBeenCalled()
  })
  it('includes classifier categories and human actions plus default and timeout as distinct source ports',()=>{
    const classifier=newNode('classifier',0,80,{classes:[{id:'kind-a',label:'类别甲'},{id:'kind-b',label:'类别乙'}]}),human=newNode('human',300,80,{actions:[{id:'approve',label:'批准'},{id:'reject',label:'退回'}]}),fixture=mount([classifier,human])
    expect(fixture.node(classifier).findAllByType('button').filter(button=>button.props.className.includes('vdw-port-out')).map(port=>port.props.title)).toEqual(['类别甲','类别乙'])
    expect(fixture.node(human).findAllByType('button').filter(button=>button.props.className.includes('vdw-port-out')).map(port=>port.props.title)).toEqual(['批准','退回','常规继续','超时'])
  })
  it('connects the explicit human default continuation with its stable port identity',()=>{
    const human=newNode('human',0,80,{actions:[{id:'approve',label:'确认继续'}]}),target=newNode('template',310,80),fixture=mount([human,target])
    const port=fixture.node(human).findAllByType('button').find(button=>button.props.title==='常规继续')!
    expect(port).toBeDefined()
    act(()=>port.props.onClick())
    act(()=>fixture.button('连接至 模板转换').props.onClick())
    expect(fixture.onEdit).toHaveBeenCalledOnce()
    expect(fixture.onEdit.mock.calls[0]![0].edges).toEqual([{id:expect.any(String),source:human.id,target:target.id,port:'default'}])
    expect(fixture.onConfigure).not.toHaveBeenCalled()
  })
  it('does not duplicate an existing branch edge and clears the connection target state',()=>{
    const source=newNode('template',0,80),target=newNode('output',300,80),workflow={...makeWorkflow('workspace','既有连接'),nodes:[source,target],notes:[],edges:[{id:'existing',source:source.id,target:target.id,port:'default'}]},fixture=mount([source,target],{workflow})
    act(()=>fixture.button('从 模板转换连接').props.onClick())
    act(()=>fixture.button('连接至 输出').props.onClick())
    expect(fixture.onEdit).not.toHaveBeenCalled()
    expect(fixture.targets()).toHaveLength(0)
    expect(workflow.edges).toHaveLength(1)
  })
  it('Escape cancels source and target highlighting without changing the graph',()=>{
    const source=newNode('template',0,80),target=newNode('output',300,80),fixture=mount([source,target])
    act(()=>fixture.button('从 模板转换连接').props.onClick())
    expect(fixture.targets()).toHaveLength(3)
    const event={key:'Escape',target:{closest:()=>null},preventDefault:vi.fn()}
    act(()=>fixture.button('工作流画布').props.onKeyDown(event))
    expect(fixture.targets()).toHaveLength(0)
    expect(fixture.onEdit).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowTemplateLibrary } from '../src/host/template-library.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { createWorkflowArchive, parseWorkflowArchive } from '../src/host/workflow-package-archive.ts'
import { parseWorkflowPackage } from '../src/shared/workflow-format.ts'
import { parseWorkflowTemplateSelection, selectWorkflowTemplateNodes } from '../src/shared/workflow-template-selection.ts'
import { createWorkflowThumbnail } from '../src/shared/workflow-thumbnail.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { makeWorkflow, type Workflow } from '../src/shared/types.ts'

const directories:string[]=[]
function directory(){const path=mkdtempSync(join(tmpdir(),'workflow-template-selection-'));directories.push(path);return path}
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})
function nested():Workflow {
  const flow=makeWorkflow('private-workspace','选区测试',true),body=makeWorkflow('private-workspace','内部',true),container=flow.nodes[1]!,agent=body.nodes[1]!
  flow.revision=7;container.kind='loop';container.config={maxIterations:3,body:{nodes:body.nodes,edges:body.edges}}
  agent.kind='agent';agent.config={subagentId:'agent-used',prompt:'{{input.text}}',inputs:{file:{workflowFileId:'local-attachment-handle'}}}
  flow.subAgents=[{id:'agent-used',number:'agent-1',name:'选中角色',prompt:'工作角色',sessionId:'private-session',rolePresetId:'local-preset',rolePresetRevision:3},{id:'agent-unused',number:'agent-2',name:'未用角色',prompt:'未选择的角色内容'}]
  flow.environmentVariables=[{id:'base',name:'PUBLIC_BASE',type:'string',value:'private-public-value'},{id:'secret',name:'API_KEY',type:'secret'}]
  flow.notes=[{id:'selected-note',text:'容器说明',x:80,y:80,anchorNodeId:container.id},{id:'outside-note',text:'未选节点说明',x:0,y:0,anchorNodeId:flow.nodes[0]!.id},{id:'free-note',text:'未关联便签',x:0,y:0}]
  flow.editor={scopePath:[container.id],annotations:[{id:'container-comment',number:1,text:'选择中的批注',nodeIds:[container.id,flow.nodes[0]!.id],position:{x:10,y:20,scopePath:[]}},{id:'nested-comment',number:2,text:'内部批注',nodeIds:[agent.id],position:{x:30,y:40,scopePath:[container.id]}},{id:'outside-comment',number:3,text:'外部批注',nodeIds:[flow.nodes[0]!.id]}]}
  return flow
}

describe('verified canvas selections for personal templates',()=>{
  it('requires a nonempty unique selection in one existing canvas and the current source revision',()=>{
    const flow=nested(),container=flow.nodes[1]!,inner=container.config.body!.nodes[1]!,valid={nodeIds:[container.id],scopePath:[],expectedRevision:7}
    for(const value of [{...valid,nodeIds:[]},{...valid,nodeIds:[container.id,container.id]},{...valid,unknown:true},{...valid,expectedRevision:-1},{...valid,scopePath:['bad!']}])expect(()=>parseWorkflowTemplateSelection(value)).toThrow()
    expect(()=>selectWorkflowTemplateNodes(flow,{...valid,expectedRevision:6})).toThrow('已被修改')
    expect(()=>selectWorkflowTemplateNodes(flow,{...valid,nodeIds:['missing']})).toThrow('不属于当前画布')
    expect(()=>selectWorkflowTemplateNodes(flow,{...valid,nodeIds:[container.id,inner.id]})).toThrow('不属于当前画布')
    expect(()=>selectWorkflowTemplateNodes(flow,{...valid,scopePath:[container.id,inner.id]})).toThrow('画布不存在')
    expect(()=>selectWorkflowTemplateNodes(flow,{...valid,nodeIds:[container.id],scopePath:[container.id]})).toThrow('不属于当前画布')
  })

  it('keeps complete selected container bodies, internal edges and only related notes and definitions',()=>{
    const flow=nested(),before=structuredClone(flow),container=flow.nodes[1]!,output=flow.nodes[2]!
    output.config.text=`{{${flow.nodes[0]!.id}.text}}`
    const fragment=selectWorkflowTemplateNodes(flow,{nodeIds:[container.id,output.id],scopePath:[],expectedRevision:7})
    expect(fragment.nodes.map(node=>node.id)).toEqual([container.id,output.id])
    expect(fragment.nodes[0]!.config.body).toEqual(parseWorkflow(flow).nodes[1]!.config.body)
    expect(fragment.edges).toEqual(flow.edges.filter(edge=>edge.source===container.id&&edge.target===output.id))
    expect(fragment.nodes[1]!.config.text).toBe(`{{${flow.nodes[0]!.id}.text}}`)
    expect(fragment.notes.map(note=>note.id)).toEqual(['selected-note'])
    expect(fragment.subAgents?.map(agent=>agent.id)).toEqual(['agent-used'])
    expect(fragment.editor?.annotations?.map(note=>[note.id,note.nodeIds,note.position?.scopePath])).toEqual([['container-comment',[container.id],[]],['nested-comment',[container.config.body!.nodes[1]!.id],[container.id]]])
    expect(flow.nodes).toEqual(before.nodes.map(node=>node.id===output.id?{...node,config:{...node.config,text:output.config.text}}:node))
    expect(flow.notes).toEqual(before.notes)
  })

  it('promotes a nested canvas selection and rebases its annotations without copying outer notes',()=>{
    const flow=nested(),container=flow.nodes[1]!,body=container.config.body!,agent=body.nodes[1]!,output=body.nodes[2]!
    const fragment=selectWorkflowTemplateNodes(flow,{nodeIds:[agent.id,output.id],scopePath:[container.id],expectedRevision:7})
    expect(fragment.nodes.map(node=>node.id)).toEqual([agent.id,output.id]);expect(fragment.edges).toHaveLength(1)
    expect(fragment.notes).toEqual([])
    expect(fragment.editor?.annotations).toEqual([{id:'nested-comment',number:2,text:'内部批注',nodeIds:[agent.id],position:{x:30,y:40,scopePath:[]}}])
    const library=new WorkflowTemplateLibrary(directory()),saved=library.save(flow,{selection:{nodeIds:[agent.id,output.id],scopePath:[container.id],expectedRevision:7}})
    expect(parseWorkflowPackage(library.get(saved.id).packageJson).workflow.nodes.map(node=>node.id)).toEqual([agent.id,output.id])
  })

  it('persists selection templates through the existing credential and local attachment stripping boundary',()=>{
    const flow=nested(),container=flow.nodes[1]!,library=new WorkflowTemplateLibrary(directory())
    const saved=library.save(flow,{title:'选择模板',selection:{nodeIds:[container.id],scopePath:[],expectedRevision:7}}),raw=readFileSync(join(library.directory,'templates.json'),'utf8'),pkg=parseWorkflowPackage(library.get(saved.id).packageJson)
    for(const hidden of ['private-workspace','private-session','private-public-value','local-attachment-handle','local-preset','未选择的角色内容','outside-note','free-note'])expect(raw).not.toContain(hidden)
    expect(pkg.workflow.environmentVariables?.map(variable=>variable.value)).toEqual([undefined,undefined])
    expect(pkg.workflow.environmentVariables?.find(variable=>variable.id==='secret')).toEqual({id:'secret',name:'API_KEY',type:'secret'})
    expect(pkg.workflow.subAgents).toEqual([{id:'agent-used',number:'agent-1',name:'选中角色',prompt:'工作角色'}])
    expect(()=>library.save(flow,{selection:{nodeIds:[container.id],scopePath:[],expectedRevision:6}})).toThrow('已被修改')
    expect(library.list().filter(template=>template.scope==='personal')).toHaveLength(1)
  })

  it('derives real thumbnail geometry for old persisted templates and every metadata surface',()=>{
    const flow=makeWorkflow('origin','布局',true),library=new WorkflowTemplateLibrary(directory())
    flow.nodes[0]!.x=-500;flow.nodes[1]!.y=210
    const saved=library.save(flow),expected=createWorkflowThumbnail(flow)
    expect(saved.thumbnail).toEqual(expected)
    const raw=JSON.parse(readFileSync(join(library.directory,'templates.json'),'utf8'))
    expect(raw.templates[0].metadata).not.toHaveProperty('thumbnail')
    const reopened=new WorkflowTemplateLibrary(library.directory)
    expect(reopened.list().find(template=>template.id===saved.id)?.thumbnail).toEqual(expected)
    expect(reopened.get(saved.id).metadata.thumbnail).toEqual(expected)
    const rename=reopened.rename(saved.id,'新名称',saved.revision);expect(rename.thumbnail).toEqual(expected)
    reopened.remove(saved.id,rename.revision);expect(reopened.archived()[0]!.thumbnail).toEqual(expected)
    expect(reopened.restore(saved.id,rename.revision+1).thumbnail).toEqual(expected)
    expect(JSON.stringify(expected)).not.toContain('config')
    expect(Object.keys(expected.nodes[0]!)).toEqual(['id','kind','x','y'])
  })

  it('returns the actual main canvas thumbnail in JSON and ZIP structural import previews',async()=>{
    const flow=makeWorkflow('origin','预览布局',true),library=new WorkflowTemplateLibrary(directory()),root=directory()
    flow.nodes[0]!.x=-300;flow.nodes[2]!.y=200
    const saved=library.save(flow),text=library.get(saved.id).packageJson,catalog={models:[],tools:[],workflows:[],presets:[]}
    const json=await prepareWorkflowImport(text,'target',{},catalog,root)
    expect(json.preview.thumbnail).toEqual(createWorkflowThumbnail(flow))
    const zip=parseWorkflowArchive((await createWorkflowArchive(flow,root)).toString('base64'))
    const archive=await prepareWorkflowImport(JSON.stringify(zip.pkg),'target',{},catalog,root)
    expect(archive.preview.thumbnail).toEqual(json.preview.thumbnail)
  })
})

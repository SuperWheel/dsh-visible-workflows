import {describe,it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkflowAuthoringCompiler} from '../src/shared/planning-authoring.ts'
import {TemplateFillingCompiler} from '../src/shared/planning-template-compiler.ts'
import {compilePlanningEdits,planningEditDigest} from '../src/shared/planning-edits.ts'
import {planningCandidateIssues} from '../src/shared/planning-projection.ts'
import {planningNativeFileWriteIssues} from '../src/shared/planning-tool-preconditions.ts'
import {templateIdForTool} from '../src/shared/planning-node-templates.ts'
import {WorkflowStorage} from '../src/host/storage.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools} from './fixtures/t18-tools.ts'
import type {WorkflowNode,NodeGraph} from '../src/shared/types.ts'

const node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']={}):WorkflowNode=>({id,kind,config,title:id,number:id,x:0,y:0,fixed:false})
function context(){
  const c=templateContext();c.tools=tools().map(({operationContract,...tool})=>tool)
  c.tools.push({...c.tools[1]!,id:'native:edit',name:'edit',inputSchema:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string']}})
  return c
}
const edges=(rows:string[][])=>rows.map(([source,target,port],i)=>({id:'e'+i,source:source!,target:target!,...(port?{port}:{})}))
function graph(toolId='native:write',path='{{input.path}}'){
  const c=context();c.workflow.nodes=[node('start','input',{fields:[{name:'path',label:'路径',required:true}]}),node('read','tool',{toolId:'native:read',inputs:{file_path:path}}),node('write','tool',{toolId,inputs:toolId==='native:edit'?{file_path:path,old_string:'old',new_string:'new'}:{file_path:path,content:'text'}}),node('end','output',{text:'done',outputName:'result'})]
  c.workflow.edges=edges([['start','read'],['read','write'],['write','end']]);return c
}
const issues=(c:ReturnType<typeof graph>)=>planningNativeFileWriteIssues(c.workflow,c)
const find=(c:ReturnType<typeof graph>,id:string)=>c.workflow.nodes.find(n=>n.id===id)!
function submission(){return {mode:'create',title:'写入',nodes:[{key:'start',kind:'input',config:{fields:[{name:'path',label:'路径',required:true}]}},{key:'write',kind:'tool',config:{toolId:'native:write',inputs:{file_path:'{{input.path}}',content:'text'}}},{key:'result',kind:'output',config:{text:'done',outputName:'result'}}],chains:[{key:'main',nodes:['start','write','result']}],coverage:{R1:['write']}}}
const filling=({nodes,...d}:any)=>({...d,forms:nodes.map(({kind,config,...rest}:any)=>{const {toolId,...values}=config;return {...rest,template:toolId?templateIdForTool(toolId):kind,values}})})

describe('planner native read-before-write guard without SDK attestations',()=>{
  it.each(['native:write','native:edit'])('checks %s with no optional operation contract',tool=>{
    const c=graph(tool);expect(issues(c)).toEqual([])
    c.workflow.edges=edges([['start','write'],['write','read'],['read','end']])
    expect(planningCandidateIssues(c.workflow,c)).toContainEqual(expect.objectContaining({code:'FILE_WRITE_NEEDS_READ',nodeId:'write'}))
  })
  it.each(['other.txt','{{input.other}}','prefix{{input.path}}','{{path}}','./out.txt'])('rejects a different or mutable read path %s',path=>{
    const c=graph('native:write',path==='./out.txt'?'out.txt':'{{input.path}}');find(c,'read').config.inputs!.file_path=path
    expect(issues(c)).toHaveLength(1)
  })
  it.each(['out.txt','{{input.path}}','{{producer.text}}'])('accepts the exact expression %s',path=>{
    const c=graph('native:write',path)
    if(path.includes('producer')){c.workflow.nodes.push(node('producer','template',{text:'out.txt'}));c.workflow.edges=edges([['start','producer'],['producer','read'],['read','write'],['write','end']])}
    expect(issues(c)).toEqual([])
  })
  it('requires all arriving routes and actual ordering, never a cached or parallel read',()=>{
    const c=graph();c.workflow.nodes.push(node('branch','if',{variable:'input.path',operator:'not_empty'}),node('other','tool',{toolId:'native:read',inputs:{file_path:'{{input.path}}'}}))
    c.workflow.edges=edges([['start','branch'],['branch','read','true'],['branch','other','false'],['read','write'],['other','write'],['write','end']]);expect(issues(c)).toEqual([])
    find(c,'other').config.inputs!.file_path='other.txt';expect(issues(c)).toHaveLength(1)
    find(c,'other').config.inputs!.file_path='{{input.path}}';find(c,'read').config.cache='reuse';expect(issues(c)).toHaveLength(1)
    find(c,'read').config.cache='never';c.workflow.edges=edges([['start','read'],['start','write'],['write','end']]);expect(issues(c)).toHaveLength(1)
  })
  it('checks nested bodies without treating outer iteration reads as the same owner',()=>{
    for(const kind of ['loop','iteration'] as const){
      const c=graph(),write=find(c,'write'),body:NodeGraph={nodes:[node('inner','input'),write],edges:edges([['inner','write']])}
      c.workflow.nodes=c.workflow.nodes.filter(n=>n.id!=='write');c.workflow.nodes.push(node('container',kind,{body}));c.workflow.edges=edges([['start','read'],['read','container'],['container','end']])
      expect(issues(c)).toHaveLength(kind==='loop'?0:1)
      body.nodes.splice(1,0,node('innerRead','tool',{toolId:'native:read',inputs:{file_path:'{{input.path}}'}}));body.edges=edges([['inner','innerRead'],['innerRead','write']]);expect(issues(c)).toEqual([])
    }
  })
  it.each([WorkflowAuthoringCompiler,TemplateFillingCompiler])('returns repairable CREATE/EDIT diagnostics and permits topology repairs in $name',C=>{
    const c=context(),compiler=new C(c),d=submission(),wire=C===TemplateFillingCompiler?filling(d):d
    const result=compiler.submit({submission:wire});expect(result.ok).toBe(false)
    if(result.ok)throw Error('expected rejection')
    const issue=result.feedback.issues.find(i=>i.code==='FILE_WRITE_NEEDS_READ')!
    expect(issue.nodeId).toBeTruthy();expect(issue.message).toContain('verified-file-write@1.1.0');expect(issue.allowedPaths).toContain('/chainsByKey')
    const root=C===TemplateFillingCompiler?'formsByKey':'nodesByKey'
    const read=C===TemplateFillingCompiler?{template:templateIdForTool('native:read'),values:{inputs:{file_path:'{{input.path}}'}}}:{kind:'tool',config:{toolId:'native:read',inputs:{file_path:'{{input.path}}'}}}
    const repaired=compiler.submit({submission:{mode:'repair',draftRevision:result.feedback.draftRevision,patches:[{op:'add',path:`/${root}/read`,value:read},{op:'replace',path:'/chainsByKey/main/nodes',value:['start','read','write','result']}]}})
    expect(repaired.ok,repaired.ok?'':JSON.stringify(repaired.feedback)).toBe(true)
    if(!repaired.ok)throw Error('repair failed')
    const flow=repaired.value.candidate!,readIndex=flow.nodes.findIndex(n=>n.config.toolId==='native:read')+1
    const edit=new C({...c,operation:'revise',workflow:flow,targetNodeIds:flow.nodes.map(n=>n.id)})
    const changed=edit.submit({submission:{mode:'edit',updates:{['n'+readIndex]:C===TemplateFillingCompiler?{values:{inputs:{file_path:'wrong.txt'}}}:{set:{inputs:{file_path:'wrong.txt'}}}},coverage:{R1:['n'+readIndex]}}})
    expect(changed.ok).toBe(false);if(!changed.ok)expect(changed.feedback.issues.map(i=>i.code)).toContain('FILE_WRITE_NEEDS_READ')
  })
  it('checks legacy edits and preserves the manual canvas storage save',()=>{
    const c=graph();c.operation='revise';c.targetNodeIds=c.workflow.nodes.map(n=>n.id)
    const changed=compilePlanningEdits({baseDigest:planningEditDigest(c.workflow),outcome:'candidate',edits:[{op:'update-node',node:'@2',configSet:{inputs:{file_path:'wrong.txt'}}}],requirementCoverage:[]},c)
    expect(changed.issues.map(i=>i.code)).toContain('FILE_WRITE_NEEDS_READ')
    const directory=mkdtempSync(join(tmpdir(),'manual-bare-write-')),storage=new WorkflowStorage(directory)
    try{expect(storage.save(changed.candidate!,0).nodes).toHaveLength(4)}finally{storage.close();rmSync(directory,{recursive:true,force:true})}
  })
})

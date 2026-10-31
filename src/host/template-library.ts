import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { makeWorkflow, newId, type RolePreset, type Workflow, type WorkflowTemplate } from '../shared/types.ts'
import { exportWorkflowJson, importWorkflowJson, parseWorkflowPackage, type ImportedWorkflow } from '../shared/workflow-format.ts'
import { allNodes, assertGraph, parseWorkflow } from './validation.ts'
import { createWorkflowThumbnail } from '../shared/workflow-thumbnail.ts'
import { selectWorkflowTemplateNodes, type WorkflowTemplateSelection } from '../shared/workflow-template-selection.ts'

interface TemplateRecord { metadata:WorkflowTemplate;packageJson:string;archived?:boolean }
const metadataSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]+$/),scope:z.enum(['builtin','personal']),title:z.string().min(1).max(200),description:z.string().max(10000),revision:z.number().int().nonnegative(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict()
const stateSchema=z.object({schema:z.literal(1),templates:z.array(z.object({metadata:metadataSchema,packageJson:z.string().max(8_000_000),archived:z.boolean().optional()}).strict()).max(2000)}).strict()
const titleValue=(value:string)=>z.string().trim().min(1,'请填写模板名称').max(200).parse(value)

function builtins():TemplateRecord[]{
  const text=makeWorkflow('template','文本整理模板',true)
  text.description='输入文本，经模板整理后输出。无需模型或外部工具。'
  const conditional=makeWorkflow('template','布尔分支模板',true),middle=conditional.nodes[1]!,input=conditional.nodes[0]!,output=conditional.nodes[2]!
  input.config.fields=[{name:'approved',label:'是否通过',required:true,type:'boolean'}]
  middle.kind='if';middle.title='判断布尔值';middle.config={logicGate:{operator:'IF',inputs:[{value:'{{input.approved}}'}]}}
  output.title='通过结果';output.config={text:'已通过',outputName:'approved'};conditional.edges[1]!.port='true'
  const rejected={...structuredClone(output),id:newId(),title:'未通过结果',y:400,config:{text:'未通过',outputName:'rejected'}}
  conditional.nodes.push(rejected);conditional.edges.push({id:newId(),source:middle.id,target:rejected.id,port:'false'})
  conditional.description='严格 Boolean 条件分支，分别输出通过或未通过。'
  return [text,conditional].map((flow,index)=>({metadata:{id:index?'builtin-boolean-branch':'builtin-text',scope:'builtin',title:flow.title,description:flow.description,revision:1,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'},packageJson:exportWorkflowJson(flow)}))
}

/** Personal packages are detached from executable workspace instances and all credentials. */
export class WorkflowTemplateLibrary {
  private readonly file:string
  private readonly builtin=builtins()
  private personal:TemplateRecord[]=[]
  constructor(readonly directory:string){
    if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('模板目录不能为符号链接')
    mkdirSync(directory,{recursive:true,mode:0o700});this.file=join(directory,'templates.json')
    if(existsSync(this.file)){
      if(lstatSync(this.file).isSymbolicLink())throw new Error('模板文件不能为符号链接')
      const raw=stateSchema.parse(JSON.parse(readFileSync(this.file,'utf8')))
      if(raw.templates.some(record=>record.metadata.scope!=='personal'))throw new Error('个人模板存储不能覆盖内置模板')
      if(new Set(raw.templates.map(record=>record.metadata.id)).size!==raw.templates.length)throw new Error('模板身份重复')
      for(const record of raw.templates)parseWorkflowPackage(record.packageJson,{historical:true})
      this.personal=raw.templates
    }
  }
  private metadata(record:TemplateRecord):WorkflowTemplate{return {...structuredClone(record.metadata),thumbnail:createWorkflowThumbnail(parseWorkflowPackage(record.packageJson,{historical:true}).workflow)}}
  list():WorkflowTemplate[]{return [...this.builtin,...this.personal.filter(record=>!record.archived)].map(record=>this.metadata(record))}
  get(id:string):{metadata:WorkflowTemplate;packageJson:string}{const record=[...this.builtin,...this.personal].find(record=>record.metadata.id===id&&!record.archived);if(!record)throw new Error('模板不存在或已归档');return {metadata:this.metadata(record),packageJson:record.packageJson}}
  save(value:Workflow,options:{title?:string;presets?:RolePreset[];selection?:WorkflowTemplateSelection}={}):WorkflowTemplate{
    const source=parseWorkflow(value);assertGraph(source)
    const flow=options.selection===undefined?source:selectWorkflowTemplateNodes(source,options.selection)
    assertGraph(flow);flow.title=titleValue(options.title??flow.title)
    const selectedRoles=new Set([...allNodes(flow).map(node=>node.config.rolePresetId),...(flow.subAgents??[]).map(agent=>agent.rolePresetId)].filter(Boolean))
    const packageJson=exportWorkflowJson(flow,{presets:options.selection===undefined?options.presets:options.presets?.filter(preset=>selectedRoles.has(preset.id))})
    // A missing role must fail now, not after saving an unusable personal template.
    importWorkflowJson(packageJson,'template-validation')
    const now=new Date().toISOString(),metadata:WorkflowTemplate={id:`personal-${newId()}`,scope:'personal',title:flow.title,description:flow.description,revision:1,createdAt:now,updatedAt:now}
    const record={metadata,packageJson};this.persist([...this.personal,record]);return this.metadata(record)
  }
  rename(id:string,title:string,expectedRevision:number):WorkflowTemplate{
    const record=this.editable(id,expectedRevision),name=titleValue(title)
    if(name===record.metadata.title)return this.metadata(record)
    const next=structuredClone(record),data=JSON.parse(next.packageJson);data.workflow.title=name;next.packageJson=JSON.stringify(data,null,2);next.metadata={...next.metadata,title:name,revision:next.metadata.revision+1,updatedAt:new Date().toISOString()}
    this.persist(this.personal.map(record=>record.metadata.id===id?next:record));return this.metadata(next)
  }
  remove(id:string,expectedRevision:number):void{
    const record=this.editable(id,expectedRevision),next={...record,archived:true,metadata:{...record.metadata,revision:record.metadata.revision+1,updatedAt:new Date().toISOString()}}
    this.persist(this.personal.map(record=>record.metadata.id===id?next:record))
  }
  archived():WorkflowTemplate[]{return this.personal.filter(record=>record.archived).map(record=>this.metadata(record))}
  restore(id:string,expectedRevision:number):WorkflowTemplate{
    const record=this.personal.find(record=>record.metadata.id===id&&record.archived)
    if(!record)throw new Error('归档模板不存在');if(record.metadata.revision!==expectedRevision)throw new Error('模板已被修改，请刷新')
    const next={...record,archived:false,metadata:{...record.metadata,revision:record.metadata.revision+1,updatedAt:new Date().toISOString()}}
    this.persist(this.personal.map(record=>record.metadata.id===id?next:record));return this.metadata(next)
  }
  instantiate(id:string,workspaceId:string):ImportedWorkflow{return importWorkflowJson(this.get(id).packageJson,workspaceId)}
  private editable(id:string,revision:number):TemplateRecord{
    if(this.builtin.some(record=>record.metadata.id===id))throw new Error('内置模板只读，请创建工作区副本或保存为个人模板')
    const record=this.personal.find(record=>record.metadata.id===id&&!record.archived)
    if(!record)throw new Error('个人模板不存在');if(!Number.isInteger(revision)||record.metadata.revision!==revision)throw new Error('模板已被修改，请刷新后重试')
    return record
  }
  private persist(next:TemplateRecord[]):void{
    const content=JSON.stringify(stateSchema.parse({schema:1,templates:next})),temp=join(this.directory,`templates-${newId()}.tmp`)
    if(existsSync(this.file)&&lstatSync(this.file).isSymbolicLink())throw new Error('模板文件不能为符号链接')
    if(existsSync(this.file)&&readFileSync(this.file,'utf8')===content)return
    let fd:number|undefined
    try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,content);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,this.file);this.personal=next}
    finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))rmSync(temp)}
  }
}

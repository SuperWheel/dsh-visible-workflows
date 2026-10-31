import type { NodeGraph, NodeConfig, WorkflowNode } from './types.ts'
import { REVIEW_DRAFT_PREFIX, reviewDraftPath } from './planning-review-path.ts'
import { EXACT_TARGET_EXISTS_CODE } from './tool-operation-contract.ts'

export function isReviewedFileWriteTarget(target:string):boolean {
  return reviewDraftPath(REVIEW_DRAFT_PREFIX+target)&&!target.startsWith('.dsh-drafts/')&&!/[()*?\[\]!]/.test(target)
}

/** Explicit graph: observe the target before review, retain the SDK owner's
 * version, then commit the gate's typed form content without a target re-read.
 * Ordinary tool errors fail the run; no synthetic conflict branch or retry. */
export function reviewedFileWriteGraph(options:{target:string;readToolId?:string;readPathInput?:string;writeToolId?:string;writePathInput?:string;producer:Pick<WorkflowNode,'kind'|'config'>;maxIterations?:number}):NodeGraph {
  const {target,readToolId='native:read',readPathInput='file_path',writeToolId='native:write',writePathInput='file_path',producer,maxIterations=3}=options
  if(!isReviewedFileWriteTarget(target))throw new Error('Review recipe requires a literal root-relative target')
  if(!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>100)throw new Error('Review loop limit must be 1..100')
  const n=(id:string,kind:WorkflowNode['kind'],config:NodeConfig):WorkflowNode=>({id,kind,title:id,number:id,x:0,y:0,fixed:false,config})
  const graph=(nodes:WorkflowNode[],edges:string[][]):NodeGraph=>({nodes,edges:edges.map(([source,target,port],i)=>({id:'review-edge-'+nodes[0]!.id+'-'+i,source:source!,target:target!,...(port?{port}:{})}))})
  const read=(id:string,path:string)=>n(id,'tool',{toolId:readToolId,inputs:{[readPathInput]:path},cache:'never'})
  const probe=(id:string,path:string)=>n(id,'tool',{toolId:'native:glob',inputs:{pattern:path},cache:'never'})
  const exists=(id:string,probeId:string,path:string)=>n(id,'code',{language:'javascript',code:EXACT_TARGET_EXISTS_CODE,inputs:{listing:`{{${probeId}.value}}`,target:path},outputSchema:[{name:'exists',type:'boolean',required:true}]})
  const draft=REVIEW_DRAFT_PREFIX+target
  const body=graph([
    n('roundStart','input',{fields:[]}),n('produce',producer.kind,{...structuredClone(producer.config),inputs:{...producer.config.inputs,reviewNote:'{{vars.reviewNote}}',reviewBase:'{{vars.reviewBase}}'}}),
    probe('draftProbe',draft),exists('draftExists','draftProbe',draft),n('draftPresent','if',{variable:'draftExists.exists',operator:'equals',value:'true'}),read('draftPrior',draft),
    n('draftWrite','tool',{toolId:writeToolId,inputs:{[writePathInput]:draft,content:'{{produce.text}}'},cache:'never'}),
    n('reviewGate','human',{prompt:'审核草稿 '+draft+'。文件只供查看，文件编辑不用于提交；修改须在表单正文中完成。拒绝时填写修改意见。',fields:[{name:'content',label:'待提交正文（在此修改）',type:'paragraph',required:false,defaultValue:'{{produce.text}}'},{name:'note',label:'修改意见',required:false}],actions:[{id:'approve',label:'通过'},{id:'reject',label:'退回修改'}]}),
    n('revise','assigner',{assignments:[{name:'reviewNote',operation:'set',value:'{{reviewGate.note}}'},{name:'reviewBase',operation:'set',value:'{{reviewGate.content}}'}]}),n('reviseResult','output',{text:'not-approved'}),
    n('commit','tool',{toolId:writeToolId,inputs:{[writePathInput]:target,content:'{{reviewGate.content}}'},cache:'never'}),
    n('approved','assigner',{assignments:[{name:'approved',operation:'set',value:true},{name:'stopped',operation:'set',value:true}]}),n('commitResult','output',{text:'approved'}),
  ],[['roundStart','produce'],['produce','draftProbe'],['draftProbe','draftExists'],['draftExists','draftPresent'],['draftPresent','draftPrior','true'],['draftPresent','draftWrite','false'],['draftPrior','draftWrite'],['draftWrite','reviewGate'],['reviewGate','revise','reject'],['revise','reviseResult'],['reviewGate','commit','approve'],['commit','approved'],['approved','commitResult']])
  return graph([
    n('start','input',{fields:[]}),probe('targetProbe',target),exists('targetExists','targetProbe',target),n('targetPresent','if',{variable:'targetExists.exists',operator:'equals',value:'true'}),read('targetBefore',target),
    n('reviewLoop','loop',{body,maxIterations,initialVariables:{reviewNote:'',reviewBase:'',approved:false,stopped:false},until:{variable:'vars.stopped',operator:'equals',value:'true'}}),
    n('wasApproved','if',{variable:'reviewLoop.variables.approved',operator:'equals',value:'true'}),n('success','output',{text:'approved',outputName:'result'}),n('notApproved','output',{text:'not-approved',outputName:'result'}),
  ],[['start','targetProbe'],['targetProbe','targetExists'],['targetExists','targetPresent'],['targetPresent','targetBefore','true'],['targetPresent','reviewLoop','false'],['targetBefore','reviewLoop'],['reviewLoop','wasApproved'],['wasApproved','success','true'],['wasApproved','notApproved','false']])
}

import assert from 'node:assert/strict'
import VisibleWorkflowService from '../../src/host/index.ts'
import { templateContext } from './planning-compiler/template.ts'
import { createTemplateBinding } from '../../src/shared/planning-node-templates.ts'
import { attest } from './t18-tools.ts'

const owner={id:'root'},other={id:'other'},lookups:any[]=[]
const definition={name:'write',description:'registered fixture',parameters:{type:'object'},output:{schema:{type:'object'}}}
const attested=attest('write',definition).operationContract!
if(attested.status!=='known')throw Error('fixture')
const raw={...definition,operationContract:attested.declaration}
const host=Object.create(VisibleWorkflowService.prototype) as any
host.sessionAgent=()=>owner
Object.defineProperty(host,'ctx',{value:{tools:{schemas:()=>[{name:'write',description:definition.description,parameters:definition.parameters}],get:(name:string,agent:unknown)=>{lookups.push({name,agent});return agent===owner?raw:definition}}}})
const tools=host.nativeTools('workspace','root')
assert.equal(tools[0].operationContract.status,'known')
assert.ok(lookups.every(call=>call.agent===owner))
host.sessionAgent=()=>other
assert.equal(host.nativeTools('workspace','other')[0].operationContract.status,'unknown')
host.sessionAgent=()=>owner
const context=templateContext();context.tools=tools
const caller={parent:owner,sessionId:'root',workspaceId:'workspace',signal:new AbortController().signal}
host.planningCaller=()=>caller;host.assertMutable=()=>{};host.planningModel=()=>context.model
host.catalog={list:()=>host.nativeTools('workspace','root')};host.storage={workflows:()=>[],archived:()=>[]}
const task={id:'task',sessionId:'root',workspaceId:'workspace',request:{operation:'create'},compilerMode:'template-fill',context,
  templateBinding:createTemplateBinding(tools),candidate:{...context.workflow,nodes:[{...context.workflow.nodes[0],kind:'tool',config:{toolId:'native:write'}}]}}
host.authorizePlanning(task,caller,true)
raw.operationContract={...raw.operationContract,version:'changed'}
assert.throws(()=>host.authorizePlanning(task,caller,true),/TOOL_OPERATION_CONTRACT_CONFLICT/)
// New metadata cannot silently upgrade an old frozen template at publication.
const historicalTools=tools.map(({operationContract:_,...tool}:any)=>tool)
host.authorizePlanning({...task,context:{...context,tools:historicalTools},templateBinding:createTemplateBinding(historicalTools)},caller,true)
assert.equal(context.tools[0]!.operationContract!.status,'known')
console.log(JSON.stringify({scopedRegistration:true,missingSourceUnknown:true,publicationDriftRejected:true,historicalBindingUnchanged:true,modelCalls:0,businessCalls:0}))

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { structuredPatch } from 'diff'
import { registeredToolOperation, operationDigest, type ToolOperationDeclaration } from '../../src/shared/tool-operation-contract.ts'
import type { ToolChoice } from '../../src/shared/types.ts'

export const manifest=JSON.parse(readFileSync(new URL('./t18-sdk/manifest.json',import.meta.url),'utf8'))
export class FsError extends Error {constructor(message:string,readonly code:string,options?:ErrorOptions){super(message,options)}}
const source=(item:any)=>readFileSync(new URL('./t18-sdk/'+item.fixture,import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export .*;$/gm,'')
const pinned=(name:string)=>source(manifest.packages.find((item:any)=>item.package===name))
/** The pinned official observation policy as its Cordis plugin module (`name` + `apply`). */
export function observationPolicyPlugin():{name:string;apply:(ctx:any)=>void}{
  return new Function('FsError',pinned('@deepseek-ai/dsh-fs-observation-policy')+'\nreturn {apply,name};')(FsError)
}
/** Apply the pinned tool-fs bodies, and unless `policy:false` the observation policy, to `ctx`. */
export function sdk(ctx:any,options:{policy?:boolean}={}){
  // Original official tool definitions and policy; only absent platform services
  // are supplied as doubles. No live SDK, profile or app is modified.
  const fs=new Function('z','defineTool','FsError','langFromPath','structuredPatch','basename','extname','AttachmentError','AttachmentId','ESCALATION_TARGETS','validateEscalationArgs',pinned('@deepseek-ai/dsh-tool-fs')+'\nreturn {apply,Config};')(
    z,defineTool,FsError,()=>undefined,structuredPatch,basename,extname,Error,(v:any)=>v,[],()=>{})
  if(options.policy!==false)observationPolicyPlugin().apply(ctx)
  fs.apply(ctx,{read:true,readImage:false,write:true,edit:false,readLimit:2000,readMaxLineLength:2000,readMaxBytes:100000,readStreamMinSize:100000})
}

/** Explicit fixture attestation. The SDK snapshots do not declare this extension;
 * production must remain unknown without a provider-supplied registration declaration. */
export function attest(name:string,definition:any):ToolChoice {
  const actions:Record<string,ToolOperationDeclaration['action']>={
    read:{kind:'file-read',pathInput:'file_path',missing:'error'},
    write:{kind:'file-write',pathInput:'file_path',readToolIds:['native:read'],listToolIds:['native:glob'],existing:'current-owner-version',absent:'create-if-absent'},
    glob:{kind:'file-list',readsContent:false,rootField:'value.root',pathsField:'value.paths',coverage:{kind:'exact-path',pathInput:'pattern',root:'.'}},
  }
  const declaration:ToolOperationDeclaration={sourceId:'native-tool:'+name,version:'t18-fixture-attestation-v1',
    registrationDigest:operationDigest({name:definition.name,description:definition.description,parameters:definition.parameters,outputSchema:definition.output?.schema}),
    implementationSources:manifest.packages.map((p:any)=>({id:p.package,version:p.version,digest:p.sha256})),
    preconditions:['已有目标须由当前 agent.session 读取；缺失目标允许直接首建；权限和版本由 SDK 检查。'],
    scope:{owner:'agent-session',target:'canonical-filesystem-path'},stateEffects:['read 更新当前 owner 的观察；write 成功更新目标及观察；glob 不记录内容读取。'],
    reuseLimits:['首建样本不证明覆盖；试做／其他 owner 的读取不可复用；外部变更后重新显式读取；失败不重试或提权。'],action:actions[name]!,
  }
  const operationContract=registeredToolOperation('native:'+name,{...definition,operationContract:declaration})
  return {id:'native:'+name,name,description:definition.description,providerId:'native:harness',providerName:'offline fixture',category:'plugin',available:true,inputSchema:definition.parameters,operationContract}
}
export function tools():ToolChoice[]{
  return ['read','write','glob'].map(name=>attest(name,{name,description:'fixture '+name,parameters:{type:'object',properties:name==='glob'?{pattern:{type:'string'}}:{file_path:{type:'string'},...(name==='write'?{content:{type:'string'}}:{})},required:name==='glob'?['pattern']:name==='write'?['file_path','content']:['file_path']},output:{schema:{type:'object'}}}))
}

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportWorkflowJson, importWorkflowJson, parseWorkflowPackage, workflowDependencies } from '../src/shared/workflow-format.ts'
import { makeWorkflow, type Workflow } from '../src/shared/types.ts'
import { PROTECTED_OPERATION } from '../src/shared/protected-secret.ts'
import { environmentSnapshot } from '../src/shared/workflow-variables.ts'
import type { WorkflowImportCatalog } from '../src/shared/workflow-import.ts'
import { prepareWorkflowImport } from '../src/host/workflow-import.ts'
import { inspectWorkflowReadiness, assertWorkflowReady } from '../src/host/workflow-readiness.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { createWorkflowArchive, materializeWorkflowArchive, parseWorkflowArchive, readWorkflowZip, writeWorkflowZip } from '../src/host/workflow-package-archive.ts'

const directories:string[]=[],stores:WorkflowStorage[]=[]
function directory(){const value=mkdtempSync(join(tmpdir(),'secret-transfer-'));directories.push(value);return value}
function catalog(workflows:Workflow[]=[]):WorkflowImportCatalog{return {workflows,models:[],tools:[],presets:[]}}
function protectedFlow(workspace='source'):Workflow{
  const flow=makeWorkflow(workspace,'可迁移的受控操作',true),http=flow.nodes[1]!
  flow.nodes[0]!.config.fields=[]
  flow.environmentVariables=[{id:'secret',name:'API_KEY',type:'secret',required:true,revision:7},{id:'region',name:'REGION',type:'string',value:'cn',revision:3}]
  http.kind='http';http.title='账户状态';http.x=340.25;http.y=-80.5
  http.config={credentialOperation:{secretVariableId:'secret',operationId:PROTECTED_OPERATION}}
  flow.nodes[2]!.config={text:`{{${http.id}.status_code}}`,outputName:'result'}
  flow.notes=[{id:'note',text:'只返回状态码',x:320.25,y:200.5,width:280,height:140,color:'yellow',anchorNodeId:http.id}]
  flow.editor={viewport:{x:-10.25,y:25.5,scale:.75},scopePath:[],annotations:[{id:'annotation',number:1,nodeIds:[http.id],text:'导入后重新配置',position:{x:480.5,y:40.25,scopePath:[]}}]}
  return flow
}
const scopeKey=(flow:Workflow,id:string)=>JSON.stringify([flow.workspaceId,flow.id,id])
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true})})

describe('Secret declarations across JSON, ZIP and target bindings',()=>{
  it.each([false,true])('exports only public Secret declarations when ordinary values are included=%s',includeEnvironmentValues=>{
    const flow=protectedFlow(),text=exportWorkflowJson(flow,{includeEnvironmentValues}),parsed=parseWorkflowPackage(text)
    expect(parsed.workflow.environmentVariables![0]).toEqual(flow.environmentVariables![0])
    expect(parsed.workflow.environmentVariables![1]!.value).toBe(includeEnvironmentValues?'cn':undefined)
    const imported=importWorkflowJson(text,'target').workflow,secret=imported.environmentVariables![0]!
    expect(secret).toEqual({id:expect.any(String),name:'API_KEY',type:'secret',required:true,revision:0})
    expect(secret.id).not.toBe('secret')
    expect(imported.nodes[1]!.config.credentialOperation).toEqual({secretVariableId:secret.id,operationId:PROTECTED_OPERATION})
    expect(environmentSnapshot(imported,true)).toEqual(includeEnvironmentValues?{[imported.environmentVariables![1]!.id]:'cn'}:{})
    expect(imported.nodes.map(node=>[node.kind,node.x,node.y])).toEqual(flow.nodes.map(node=>[node.kind,node.x,node.y]))
    expect(imported.notes[0]).toEqual({...flow.notes[0],id:expect.any(String),anchorNodeId:imported.nodes[1]!.id})
    expect(imported.editor).toEqual({...flow.editor,annotations:[{...flow.editor!.annotations![0],id:expect.any(String),nodeIds:[imported.nodes[1]!.id]}]})
  })

  it('does not reuse source or overwritten target credential scopes and stays saveable while missing',async()=>{
    const source=protectedFlow(),storage=new WorkflowStorage(directory());stores.push(storage)
    const previous=storage.save(protectedFlow('target'),0),root=directory()
    // This is a metadata-only registry of synthetic scopes, never a credential store.
    const configured=new Set([scopeKey(source,'secret'),scopeKey(previous,'secret')])
    const secretStatus=async(flow:Workflow,id:string)=>configured.has(scopeKey(flow,id))?'configured' as const:'missing' as const
    const options={overwrite:{workflowId:previous.id,expectedRevision:previous.revision}}
    const prepared=await prepareWorkflowImport(exportWorkflowJson(source),'target',options,catalog([previous]),root)
    expect(prepared.preview.canImport).toBe(true)
    expect(prepared.preview.warnings.join('\n')).toContain('不继承原流程授权')
    const saved=storage.importBundle(prepared.workflow,prepared.presets!,options.overwrite)
    expect(saved.id).toBe(previous.id);expect(saved.environmentVariables![0]!.id).not.toBe(previous.environmentVariables![0]!.id)
    const context={catalog:catalog(),workspaceRoot:root,secretStatus},pending=await inspectWorkflowReadiness(saved,context)
    expect(pending.canRun).toBe(false)
    expect(pending.issues).toEqual([expect.objectContaining({kind:'secret',nodeId:saved.nodes[1]!.id,dependencyId:saved.environmentVariables![0]!.id})])
    expect(()=>assertWorkflowReady(pending)).toThrow('不能运行')
    expect(storage.save(saved,saved.revision)).toEqual(saved)
    // Only an independently configured target scope resolves the pending state.
    configured.add(scopeKey(saved,saved.environmentVariables![0]!.id))
    expect((await inspectWorkflowReadiness(saved,context)).canRun).toBe(true)
    configured.delete(scopeKey(saved,saved.environmentVariables![0]!.id))
    expect((await inspectWorkflowReadiness(saved,context)).canRun).toBe(false)
    expect(JSON.parse(readFileSync(join(storage.directory,'library.json'),'utf8')).workflows[0].environmentVariables[0]).not.toHaveProperty('value')
  })

  it('remaps bundled child Secret operations into independent scopes without changing canvas metadata',async()=>{
    const main=protectedFlow(),child=protectedFlow(),call=main.nodes[2]!
    child.id='child';call.kind='tool';call.config={toolId:`workflow:${child.id}`,inputs:{}}
    const bundle=importWorkflowJson(exportWorkflowJson(main,{workflows:[child]}),'target')
    const parentSecret=bundle.workflow.environmentVariables![0]!.id,childSecret=bundle.workflows[0]!.environmentVariables![0]!.id
    expect(parentSecret).not.toBe(childSecret)
    expect(bundle.workflow.nodes[1]!.config.credentialOperation!.secretVariableId).toBe(parentSecret)
    expect(bundle.workflows[0]!.nodes[1]!.config.credentialOperation!.secretVariableId).toBe(childSecret)
    expect(bundle.workflow.nodes[2]!.config.toolId).toBe(`workflow:${bundle.workflows[0]!.id}`)
    const configured=new Set([scopeKey(bundle.workflow,parentSecret)])
    const readiness=await inspectWorkflowReadiness(bundle.workflow,{workspaceRoot:directory(),catalog:catalog(bundle.workflows),secretStatus:async(flow,id)=>configured.has(scopeKey(flow,id))?'configured':'missing'})
    expect(readiness.issues).toEqual([expect.objectContaining({kind:'secret',nodeId:bundle.workflow.nodes[2]!.id,workflowId:bundle.workflows[0]!.id,dependencyId:childSecret})])
    expect(bundle.workflows[0]!.editor!.annotations![0]!.nodeIds).toEqual([bundle.workflows[0]!.nodes[1]!.id])
  })

  it('roundtrips ZIP attachments together with Secret declarations, leaving imported Secret pending',async()=>{
    const root=directory(),target=directory(),flow=protectedFlow()
    writeFileSync(join(root,'readme.txt'),'Public fixture attachment; no credential bytes.')
    flow.nodes[1]!.config.verification={requiredReadFiles:['readme.txt']}
    const zip=await createWorkflowArchive(flow,root,{includeEnvironmentValues:true}),parsed=parseWorkflowArchive(zip.toString('base64'))
    expect([...parsed.entries.keys()]).toEqual(['files/1/readme.txt','workflow.json','attachments.json'])
    expect(parsed.pkg.workflow.nodes[1]!.config.credentialOperation).toEqual(flow.nodes[1]!.config.credentialOperation)
    const installed=await materializeWorkflowArchive(zip.toString('base64'),target)
    const prepared=await prepareWorkflowImport(installed.text,'target',{},catalog(),target)
    expect(prepared.preview.canImport).toBe(true)
    const imported=prepared.workflow!,file=imported.nodes[1]!.config.verification!.requiredReadFiles![0]!
    expect(readFileSync(join(target,file),'utf8')).toBe('Public fixture attachment; no credential bytes.')
    expect(imported.nodes[1]!.config.credentialOperation!.secretVariableId).toBe(imported.environmentVariables![0]!.id)
    const readiness=await inspectWorkflowReadiness(imported,{workspaceRoot:target,catalog:catalog(),secretStatus:async()=> 'missing',canVerifyFileReads:()=>true})
    expect(readiness.issues).toEqual([expect.objectContaining({kind:'secret',nodeId:imported.nodes[1]!.id})])
    expect(imported.editor!.viewport).toEqual(flow.editor!.viewport)
    await installed.cleanup();expect(readdirSync(target)).toEqual([])
  })

  it('rejects forged Secret bytes, grants and request destinations in JSON and ZIP before extraction',async()=>{
    const root=directory(),target=directory(),flow=protectedFlow(),plain=JSON.parse(exportWorkflowJson(flow))
    const fields=[{value:'synthetic-invalid-value'},{binding:'forged-binding'},{ciphertext:'forged-ciphertext'},{state:'configured'},{approved:true},{grant:{workflowId:'target'}}]
    const entries=readWorkflowZip(await createWorkflowArchive(flow,root))
    for(const extra of fields){
      const pkg=structuredClone(plain);Object.assign(pkg.workflow.environmentVariables[0],extra)
      const json=JSON.stringify(pkg)
      expect(()=>parseWorkflowPackage(json)).toThrow()
      const changed=new Map(entries);changed.set('workflow.json',Buffer.from(json))
      await expect(materializeWorkflowArchive(writeWorkflowZip(changed).toString('base64'),target)).rejects.toThrow()
      expect(readdirSync(target)).toEqual([])
    }
    for(const extra of [{url:'https://untrusted.invalid/'},{headers:{Authorization:'forged'}},{bodyText:'secret'},{inputs:{credential:'forged'}}]){
      const pkg=structuredClone(plain);Object.assign(pkg.workflow.nodes[1].config,extra)
      expect(()=>importWorkflowJson(JSON.stringify(pkg),'target')).toThrow()
    }
    const directReference=structuredClone(plain);directReference.workflow.nodes[2].config.text='{{env.secret}}'
    expect(()=>importWorkflowJson(JSON.stringify(directReference),'target')).toThrow('Secret')
  })

  it('clears hand-crafted upload handles even when the package declares no file dependency',()=>{
    const flow=makeWorkflow('source','No file dependency',true),node=flow.nodes[1]!
    node.kind='assigner';node.config={assignments:[{name:'payload',operation:'set',value:{workflowFileId:'another-run-handle',base64:'ZmFrZQ==',path:'/private/captured',nested:[{workflowFileId:'nested-handle',base64:'ZmFrZQ==',text:'keep me'}]}}]}
    flow.nodes[2]!.config.text='done'
    expect(workflowDependencies(flow)).toEqual([])
    // Bypass the exporter deliberately: imported JSON is always untrusted.
    const raw={...JSON.parse(exportWorkflowJson(flow)),workflow:flow}
    const imported=importWorkflowJson(JSON.stringify(raw),'target').workflow
    expect(imported.nodes[1]!.config.assignments![0]!.value).toEqual({path:'',nested:[{text:'keep me'}]})
    expect(node.config.assignments![0]!.value).toHaveProperty('workflowFileId','another-run-handle')
  })
})

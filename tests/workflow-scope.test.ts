import { describe, expect, it } from 'vitest'
import { makeWorkflow } from '../src/shared/types.ts'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { workflowScope, workflowVisibleInWorkspace } from '../src/shared/workflow-scope.ts'
import { workflowForExecution } from '../src/host/workflow-scope.ts'

describe('explicit workflow definition visibility',()=>{
  it('keeps legacy definitions local and accepts only the two declared scopes',()=>{
    const legacy=makeWorkflow('owner')
    expect(workflowScope(parseWorkflow(legacy))).toBe('workspace')
    expect(parseWorkflow({...legacy,scope:'global'}).scope).toBe('global')
    expect(()=>parseWorkflow({...legacy,scope:'all'})).toThrow()
    expect(()=>parseWorkflow({...legacy,scope:true})).toThrow()
  })
  it('never interprets a missing project as permission to read the full library',()=>{
    const local=makeWorkflow('owner'),global={...local,scope:'global' as const}
    expect(workflowVisibleInWorkspace(local,'caller')).toBe(false)
    expect(workflowVisibleInWorkspace(global,'caller')).toBe(true)
    expect(workflowVisibleInWorkspace(global,'')).toBe(false)
    expect(workflowVisibleInWorkspace({...global,archived:true},'caller')).toBe(false)
  })
  it('projects shared definitions into caller resource scope without copying local file or conversation bindings',()=>{
    const source={...makeWorkflow('owner','Shared',true),scope:'global' as const,subAgents:[{id:'role',number:'agent-1',name:'Role',prompt:'Shared role text',sessionId:'owner-session'}]}
    source.nodes[1]!.kind='document';source.nodes[1]!.config={source:'/owner/private.txt',inputs:{file:{workflowFileId:'old-upload',path:'/owner/upload.txt'}},verification:{requiredFiles:['/owner/output.txt']}}
    const before=structuredClone(source),projected=workflowForExecution(source,'caller')
    expect(projected.id).toBe(source.id);expect(projected.workspaceId).toBe('caller')
    expect(projected.nodes[1]!.config.source).toBe('');expect(projected.nodes[1]!.config.inputs).toEqual({file:{path:''}})
    expect(projected.nodes[1]!.config.verification!.requiredFiles![0]).toContain('__WORKFLOW_FILE_REBIND_REQUIRED__')
    expect(projected.subAgents![0]).toMatchObject({id:'role',prompt:'Shared role text'});expect(projected.subAgents![0]!.sessionId).toBeUndefined()
    expect(source).toEqual(before)
  })
  it('retains ordinary project session protection and denies private cross-project execution',()=>{
    const local={...makeWorkflow('owner'),subAgents:[{id:'role',number:'agent-1',name:'Role',prompt:'Role',sessionId:'owner-session'}]}
    expect(workflowForExecution(local,'owner').subAgents![0]!.sessionId).toBe('owner-session')
    expect(()=>workflowForExecution(local,'caller')).toThrow('当前工作区或全局')
  })
})

import { describe,expect,it } from 'vitest'
import { makeWorkflow, type WorkflowNode } from '../src/shared/types.ts'
import { createWorkflowSubagent,bindNodeSubagent,bindWorkflowSubagentsForRun,workflowSubagentScopeIssues } from '../src/shared/workflow-subagents.ts'
import { graphIssues,parseWorkflow,protectFixedNodes,workflowNodeConfigSchema } from '../src/shared/workflow-validation.ts'
import { exportWorkflowJson,importWorkflowJson } from '../src/shared/workflow-format.ts'

const fixture=()=>{const flow=makeWorkflow('workspace');const node:WorkflowNode={id:'agentnode',number:'a-3',kind:'agent',title:'分析员',x:500,y:120,fixed:false,config:{prompt:'分析 {{input.text}}',maxSteps:6}};flow.nodes.push(node);return {flow,node}}
describe('workflow-local subagent definitions',()=>{
  it('gives one logical identity to multiple nodes, with independent task prompts and shared role snapshots',()=>{
    const {flow,node}=fixture(),definition=createWorkflowSubagent(flow,'分析员','main',{id:'preset',name:'研究员',prompt:'角色',revision:2})
    bindNodeSubagent(flow,node.id,definition,'main')
    const second=structuredClone(node);second.id='second';second.config.prompt='第二项任务';flow.nodes.push(second)
    expect(flow.subAgents).toHaveLength(1);expect(node.config.subagentId).toBe(second.config.subagentId)
    expect(flow.subAgents![0]).toMatchObject({number:'agent-1',name:'分析员',prompt:'角色',sessionId:'main'})
    expect(second.config.prompt).toBe('第二项任务');expect(()=>createWorkflowSubagent(flow,' 分析员 ','main')).toThrow('同名')
    expect(()=>createWorkflowSubagent(flow,'分析员','other')).toThrow('同名')
    expect(createWorkflowSubagent(flow,'新分析员','other').number).toBe('agent-2')
  })
  it('rejects old Agent role fields instead of silently migrating or dropping them',()=>{
    const {flow,node}=fixture();node.config.rolePresetId='role'
    expect(()=>parseWorkflow(flow)).toThrow('不再支持 rolePresetId')
    expect(()=>workflowNodeConfigSchema('agent').parse(node.config)).toThrow()
    expect(node.config.rolePresetId).toBe('role');expect(flow.subAgents).toBeUndefined()
    expect(workflowNodeConfigSchema('llm').parse({rolePresetId:'role'})).toMatchObject({rolePresetId:'role'})
  })
  it('keeps an unbound Agent editable while requiring a definition before execution',()=>{
    const {flow,node}=fixture()
    expect(parseWorkflow(flow).subAgents).toBeUndefined();expect(graphIssues(flow)).toEqual([])
    expect(graphIssues(flow,true)).toContainEqual({nodeId:node.id,message:'请选择或创建此节点的子 Agent'})
    bindWorkflowSubagentsForRun(flow,'main');expect(flow.subAgents).toBeUndefined();expect(node.config.subagentId).toBeUndefined()
  })
  it('refuses foreign main-conversation reuse and only binds unbound definitions',()=>{
    const {flow,node}=fixture();bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,'A'))
    bindWorkflowSubagentsForRun(flow,'main');expect(flow.subAgents![0].sessionId).toBe('main')
    expect(workflowSubagentScopeIssues(flow,'other')).toHaveLength(1)
    expect(()=>bindWorkflowSubagentsForRun(flow,'other')).toThrow('其他主对话')
    expect(()=>bindNodeSubagent(flow,node.id,flow.subAgents![0],'other')).toThrow('其他主对话')
  })
  it('exports exact role/task prompts and rekeys logical ids without exporting session or preset links',()=>{
    const {flow,node}=fixture();bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,'A','private-session',{id:'local-preset',name:'r',prompt:'Literal {{agentnode.text}}',revision:9}),'private-session')
    flow.budgetDecision={mode:'unlimited',decidedAt:'2026-10-17T09:00:00.000Z'}
    flow.editor={viewport:{x:12,y:9,scale:.75},annotations:[{id:'ann',number:1,nodeIds:[node.id],text:'保留批注'}]}
    const json=exportWorkflowJson(flow),raw=JSON.parse(json)
    expect(json).not.toContain('private-session');expect(json).not.toContain('local-preset')
    const imported=importWorkflowJson(json,'destination').workflow,importedAgent=imported.nodes.find(node=>node.kind==='agent')!
    expect(imported.subAgents![0].id).not.toBe(flow.subAgents![0].id)
    expect(importedAgent.config.subagentId).toBe(imported.subAgents![0].id)
    expect(imported.subAgents![0]).toEqual({id:importedAgent.config.subagentId,number:'agent-1',name:'A',prompt:'Literal {{agentnode.text}}'})
    expect(importedAgent.config.prompt).toBe('分析 {{input.text}}');expect(importedAgent.x).toBe(500)
    expect(imported.editor?.annotations?.[0].nodeIds).toEqual([importedAgent.id]);expect(imported.editor?.viewport).toEqual(flow.editor.viewport)
    expect(imported.budgetDecision).toEqual(flow.budgetDecision);expect(raw.workflow.subAgents).toHaveLength(1)
  })
  it('strips forged portable session bindings and preserves unresolved identity as an editable missing value',()=>{
    const {flow,node}=fixture();bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,'A','main'),'main')
    const raw=JSON.parse(exportWorkflowJson(flow));raw.workflow.subAgents[0].sessionId='forged-session'
    expect(importWorkflowJson(JSON.stringify(raw),'dest').workflow.subAgents![0].sessionId).toBeUndefined()
    flow.subAgents=[];expect(graphIssues(flow)).toEqual([])
    expect(graphIssues(flow,true).some(issue=>issue.nodeId===node.id&&issue.message.includes('子 Agent 定义缺失'))).toBe(true)
  })
  it('rejects duplicated logical identities/numbers/names and unknown native payload fields',()=>{
    const {flow,node}=fixture();bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,'A','main'),'main');flow.subAgents!.push({...flow.subAgents![0]})
    expect(graphIssues(flow).map(issue=>issue.message)).toEqual(expect.arrayContaining(['子 Agent 身份重复','子 Agent 编号重复','同一工作流中的子 Agent 名称重复']))
    expect(()=>parseWorkflow({...flow,subAgents:[{...flow.subAgents![0],nativeSessionId:'bad'}]})).toThrow()
  })
  it('protects fixed-node roles against definition edits and disallows Secret interpolation in role text',()=>{
    const {flow,node}=fixture();bindNodeSubagent(flow,node.id,createWorkflowSubagent(flow,'A','main'),'main');node.fixed=true
    const changed=structuredClone(flow);changed.subAgents![0]!.prompt='修改角色'
    expect(()=>protectFixedNodes(flow,changed)).toThrow('子 Agent 定义不能由 Agent 修改')
    flow.environmentVariables=[{id:'secret-id',name:'API_KEY',type:'secret'}]
    for(const prompt of ['{{env.secret-id}}',"{{ env['secret-id'] }}"]){flow.subAgents![0]!.prompt=prompt;expect(graphIssues(flow).some(issue=>issue.nodeId===node.id&&issue.message.includes('不能读取 Secret'))).toBe(true)}
  })
})

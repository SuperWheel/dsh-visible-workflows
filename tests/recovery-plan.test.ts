import { describe, expect, it } from 'vitest'
import { buildRecoveryPlan, workflowSemanticDigest } from '../src/host/recovery-plan.ts'
import { reviewedRecovery } from '../src/host/recovery-review.ts'
import type { NodeConfig, NodeExecution, NodeKind, Workflow, WorkflowNode, WorkflowRun } from '../src/shared/types.ts'

const node=(id:string,kind:NodeKind='template',config:NodeConfig={text:'fixed'}):WorkflowNode=>({id,kind,config,title:id,number:id,x:0,y:0,fixed:false})
const flow=(nodes:WorkflowNode[]=[node('input','input',{fields:[{name:'text',label:'Text',required:true}]}),node('work'),node('output','output',{text:'{{work.text}}'})]):Workflow=>({id:'flow',workspaceId:'workspace',title:'Flow',description:'',revision:1,createdAt:'2026-10-16T00:00:00Z',updatedAt:'2026-10-16T00:00:00Z',nodes,edges:nodes.slice(1).map((n,i)=>({id:`edge-${i}`,source:nodes[i]!.id,target:n.id})),notes:[]})
const record=(n:WorkflowNode,executionId=n.id,status:NodeExecution['status']='success'):NodeExecution=>({nodeId:n.id,executionId,title:n.title,number:n.number,status,...(status==='pending'||status==='skipped'?{}:{startedAt:'2026-10-16T00:00:00Z'}),...(status==='success'?{data:{text:executionId},output:executionId}:{})})
const run=(graph=flow()):WorkflowRun=>({id:'run',workflowId:graph.id,workspaceId:graph.workspaceId,workflowTitle:graph.title,sourceRevision:1,graph,status:'failed',inputs:{text:'fixed'},outputs:{},executions:graph.nodes.map(n=>record(n)),startedAt:'2026-10-16T00:00:00Z'})
const item=(source:WorkflowRun,id:string,target?:Workflow)=>buildRecoveryPlan(source,'resume',target).items.find(i=>i.executionId===id)!
function frozen<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))frozen(child)}return value}
function containerRun(kind:'iteration'|'loop'='iteration'){
  const body=flow([node('bodyInput','input',{fields:[]}),node('bodyWork'),node('bodyOutput','output',{text:'{{bodyWork.text}}'})])
  const container=node('container',kind,{body:{nodes:body.nodes,edges:body.edges},...(kind==='iteration'?{iterator:'[1,2]',outputVariable:'bodyOutput.text'}:{maxIterations:2,initialVariables:{count:0}})})
  const source=run(flow([node('input','input',{fields:[]}),container,node('output','output',{text:'{{container.text}}'})]))
  source.executions[1]=record(container,'container','failed');source.executions[2]=record(source.graph.nodes[2]!,'output','skipped')
  for(let iteration=0;iteration<2;iteration++)for(const n of body.nodes)source.executions.push({...record(n,`container[${iteration}]/${n.id}`),parentNodeId:'container',iteration})
  return source
}

describe('read-only recovery planning',()=>{
  it('reuses successful deterministic results without mutating frozen input',()=>{
    const source=frozen(run()),before=JSON.stringify(source),plan=buildRecoveryPlan(source,'resume')
    expect(plan.allowed).toBe(true);expect(plan.items.every(i=>i.action==='reuse')).toBe(true);expect(plan.invalidNodeIds).toEqual([]);expect(JSON.stringify(source)).toBe(before)
  })
  it('blocks unknown external effects before considering a replacement or removed node',()=>{
    for(const kind of ['agent','tool','http','document'] as const){const source=run();source.graph.nodes[1]!.kind=kind;source.executions[1]!.status='cancelled';delete source.executions[1]!.data
      const target=structuredClone(source.graph);target.nodes.splice(1,1);target.edges=[{id:'direct',source:'input',target:'output'}]
      const plan=buildRecoveryPlan(source,'resume',target)
      expect(plan.allowed).toBe(false);expect(plan.items.find(i=>i.nodeId==='work')).toMatchObject({action:'blocked',reason:expect.stringContaining('结果未确认')})
    }
  })
  it('blocks replay of completed external actions, while explicit unchanged cached receipts can be reused',()=>{
    const source=run();source.graph.nodes[1]!.kind='http';source.graph.nodes[1]!.config={url:'https://service.test',method:'POST'}
    expect(buildRecoveryPlan(source,'resume').allowed).toBe(false);expect(item(source,'work').reason).toContain('已完成的外部操作不能自动重放')
    source.graph.nodes[1]!.config.cache='reuse';expect(item(source,'work').action).toBe('reuse');expect(buildRecoveryPlan(source,'resume').allowed).toBe(true)
    const target=structuredClone(source.graph);target.nodes[1]!.config.method='PUT';expect(item(source,'work',target).action).toBe('blocked')
  })
  it('never treats a cached protected HTTP receipt as current authorization and invalidates descendants',()=>{
    const source=run();source.graph.environmentVariables=[{id:'token',name:'TOKEN',type:'secret'}];source.graph.nodes[1]!.kind='http';source.graph.nodes[1]!.config={credentialOperation:{secretVariableId:'token',operationId:'deepseek.account-status.v1'},cache:'reuse'}
    source.executions[1]!.data={ok:true,status_code:200};source.executions[1]!.output='{"ok":true,"status_code":200}'
    const before=JSON.stringify(source),plan=buildRecoveryPlan(frozen(source),'resume')
    expect(plan.allowed).toBe(false);expect(item(source,'input').action).toBe('reuse')
    expect(item(source,'work')).toMatchObject({action:'blocked',reviewCanComplete:false,reason:expect.stringContaining('重新核验当前授权')})
    expect(item(source,'output').action).toBe('rerun');expect(plan.invalidNodeIds).toEqual(['output','work']);expect(JSON.stringify(source)).toBe(before)
  })
  it('requires an explicit protected-operation redo even for the same paused run and rejects manual completion',()=>{
    const source=run();source.status='paused';source.systemVariables={workflow_run_id:'run',timestamp:1};source.graph.nodes[1]!.kind='http';source.graph.nodes[1]!.config={credentialOperation:{secretVariableId:'token',operationId:'deepseek.account-status.v1'},cache:'reuse'}
    const same=buildRecoveryPlan(source,'resume',source.graph,{systemVariables:source.systemVariables})
    expect(same.items.find(item=>item.nodeId==='work')).toMatchObject({action:'blocked',reviewCanComplete:false})
    const base=reviewedRecovery(source).plan,decision={executionId:'work',evidence:'核对旧回执后继续'}
    expect(base.items.find(item=>item.nodeId==='work')?.reviewable).toBe(true)
    expect(()=>reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{...decision,action:'completed',output:{ok:true,status_code:200}}]})).toThrow('绕过失效规则')
    const redo=reviewedRecovery(source,{baseDigest:base.planDigest,decisions:[{...decision,action:'redo'}]}).plan
    expect(redo.allowed).toBe(true);expect(redo.items.find(item=>item.nodeId==='work')?.action).toBe('rerun');expect(redo.items.find(item=>item.nodeId==='output')?.action).toBe('rerun')
  })
  it('does not reuse cached workflow or Agent callers that contain recursive protected operations',()=>{
    const source=run(),child=flow([node('call','tool',{toolId:'workflow:grandchild',cache:'reuse'})]),grandchild=flow([node('secure','http',{credentialOperation:{secretVariableId:'token',operationId:'deepseek.account-status.v1'},cache:'reuse'})]);child.id='child';grandchild.id='grandchild';source.dependencySnapshots={child,grandchild}
    for(const kind of ['tool','agent'] as const){source.graph.nodes[1]!.kind=kind;source.graph.nodes[1]!.config={...(kind==='tool'?{toolId:'workflow:child'}:{tools:['workflow:child']}),cache:'reuse'}
      expect(item(source,'work')).toMatchObject({action:'blocked',reviewCanComplete:false});expect(item(source,'output').action).toBe('rerun')
    }
    grandchild.nodes.push(node('cycle','tool',{toolId:'workflow:child'}));expect(()=>buildRecoveryPlan(source,'resume')).not.toThrow()
  })
  it('allows explicit rerun planning but never describes it as reuse',()=>{
    const source=run();source.graph.nodes[1]!.kind='agent';source.executions[1]!.status='failed'
    const plan=buildRecoveryPlan(source,'rerun');expect(plan.allowed).toBe(true);expect(plan.items.every(i=>i.action==='rerun')).toBe(true);expect(plan.items[0]!.reason).toContain('用户选择')
  })
  it('does not confuse a pending external task with an already sent action',()=>{
    const source=run();source.graph.nodes[1]!.kind='tool';source.executions[1]=record(source.graph.nodes[1]!,'work','pending')
    const plan=buildRecoveryPlan(source,'resume');expect(plan.allowed).toBe(true);expect(item(source,'work').action).toBe('rerun')
    source.executions[1]!.subagentId='known-task';expect(item(source,'work').action).toBe('blocked')
  })
  it.each(['workflow_run_id','timestamp','session_id','user_id','app_id'])('never permits explicit cache to bypass sys.%s invalidation',name=>{
    const source=run();source.graph.nodes[1]!.config={text:`{{sys.${name}}}`,cache:'reuse'}
    expect(item(source,'work').action).toBe('rerun');expect(item(source,'output').action).toBe('rerun');expect(item(source,'input').action).toBe('reuse')
  })
  it('also checks dynamic identity references inside frozen roles',()=>{
    const source=run();source.graph.nodes[1]!.kind='llm';source.graph.nodes[1]!.config.cache='reuse';source.rolePrompts={work:'Current caller {{sys.session_id}}'}
    expect(item(source,'work').reason).toContain('调用者身份')
  })
  it('invalidates file inputs and their descendants even with explicit reuse',()=>{
    const source=run();source.graph.nodes[0]!.config={fields:[{name:'file',label:'File',required:true,type:'file'}],cache:'reuse'}
    const plan=buildRecoveryPlan(source,'resume');expect(plan.items.every(i=>i.action==='rerun')).toBe(true);expect(item(source,'input').reason).toContain('文件输入')
  })
  it('requires explicit cache for code, and still rejects known dynamic code',()=>{
    const source=run();source.graph.nodes[1]!.kind='code';source.graph.nodes[1]!.config={code:'function main(inputs) { return {text: inputs.text} }'}
    expect(item(source,'work').action).toBe('rerun');source.graph.nodes[1]!.config.cache='reuse';expect(item(source,'work').action).toBe('reuse')
    for(const code of ['Date.now()','Math.random()','crypto.randomUUID()','time.time()']){source.graph.nodes[1]!.config.code=code;expect(item(source,'work').action).toBe('rerun')}
  })
  it('treats current-time tools and file-dependent results as dynamic despite explicit reuse',()=>{
    const source=run();source.graph.nodes[1]!.kind='tool';source.graph.nodes[1]!.config={toolId:'builtin:time.now',cache:'reuse'}
    expect(item(source,'work').action).toBe('blocked')
    source.graph.nodes[1]!.kind='template';source.graph.nodes[1]!.config={text:'old',cache:'reuse',verification:{requiredFiles:['result.txt']}}
    expect(item(source,'work').action).toBe('rerun')
  })
  it('invalidates changed upstream routing/config and blocks downstream cached external effects',()=>{
    const source=run();source.graph.nodes[2]!.kind='http';source.graph.nodes[2]!.config={url:'https://service.test',cache:'reuse'}
    const target=structuredClone(source.graph);target.nodes[1]!.config.text='changed'
    const plan=buildRecoveryPlan(source,'resume',target);expect(item(source,'input',target).action).toBe('reuse');expect(item(source,'work',target).action).toBe('rerun');expect(item(source,'output',target).action).toBe('blocked');expect(plan.allowed).toBe(false)
    target.nodes[1]!.config.text='fixed';target.edges[0]!.port='other';expect(item(source,'work',target).reason).toContain('连线')
  })
  it('only invalidates consumers of changed environment values, not display names',()=>{
    const source=run();source.graph.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'old'}];source.environment={region:'old'};source.graph.nodes[1]!.config.text='{{env.region}}'
    const target=structuredClone(source.graph);target.environmentVariables![0]!.name='RENAMED';expect(item(source,'work',target).action).toBe('reuse')
    target.environmentVariables![0]!.value='new';expect(item(source,'work',target).reason).toContain('环境变量');expect(item(source,'output',target).action).toBe('rerun');expect(item(source,'input',target).action).toBe('reuse')
  })
  it('rejects invalid successful receipts and duplicate/unscoped execution identities',()=>{
    const source=run();source.executions[1]!.verification={status:'failed',reasons:['invalid']};expect(item(source,'work').action).toBe('rerun')
    source.executions.push(structuredClone(source.executions[0]!));expect(buildRecoveryPlan(source,'resume').allowed).toBe(false)
    const nested=containerRun();nested.executions[3]!.executionId='bodyInput';expect(buildRecoveryPlan(nested,'resume').blockedReasons.join(' ')).toContain('实例路径')
  })
  it('permits a stopped paused revision plan but rejects active roots and direct child recovery',()=>{
    const source=run();source.status='paused';expect(buildRecoveryPlan(source,'resume',structuredClone(source.graph)).allowed).toBe(true)
    source.status='pausing';expect(buildRecoveryPlan(source,'resume',source.graph).allowed).toBe(false)
    source.status='paused';source.rootRunId='parent';expect(buildRecoveryPlan(source,'resume').allowed).toBe(false)
  })
})

describe('container execution-instance dependencies',()=>{
  it('keeps completed parallel iteration instances reusable when another item failed',()=>{
    const source=containerRun(),failed=source.executions.find(e=>e.executionId==='container[1]/bodyWork')!;failed.status='failed';delete failed.data
    expect(item(source,'container[0]/bodyWork').action).toBe('reuse');expect(item(source,'container[0]/bodyOutput').action).toBe('reuse')
    expect(item(source,'container[1]/bodyWork').action).toBe('rerun');expect(item(source,'container[1]/bodyOutput').action).toBe('rerun');expect(item(source,'container').action).toBe('rerun');expect(item(source,'output').action).toBe('rerun')
  })
  it('invalidates children when container inputs change and blocks nested successful side effects',()=>{
    const source=containerRun(),body=source.graph.nodes[1]!.config.body!;body.nodes[1]!.kind='http';body.nodes[1]!.config={url:'https://service.test',cache:'reuse'}
    const target=structuredClone(source.graph);target.nodes[1]!.config.iterator='[3,4]'
    const plan=buildRecoveryPlan(source,'resume',target);expect(plan.allowed).toBe(false);expect(item(source,'container[0]/bodyWork',target).action).toBe('blocked');expect(item(source,'container[1]/bodyWork',target).action).toBe('blocked')
  })
  it('invalidates later loop rounds after an earlier round changes, without invalidating earlier independent state',()=>{
    const source=containerRun('loop');source.executions.find(e=>e.executionId==='container[0]/bodyWork')!.status='failed'
    expect(item(source,'container[0]/bodyInput').action).toBe('reuse');expect(item(source,'container[1]/bodyInput').action).toBe('rerun');expect(item(source,'container[1]/bodyWork').action).toBe('rerun')
  })
  it('reports a new body node in each known instance and invalidates its downstream results',()=>{
    const source=containerRun(),target=structuredClone(source.graph),body=target.nodes[1]!.config.body!;body.nodes.push(node('newNode'));body.edges.push({id:'newEdge',source:'newNode',target:'bodyOutput'})
    const plan=buildRecoveryPlan(source,'resume',target)
    expect(plan.items.filter(i=>i.nodeId==='newNode').map(i=>i.executionId)).toEqual(['container[0]/newNode','container[1]/newNode']);expect(item(source,'container[0]/bodyOutput',target).action).toBe('rerun')
  })
  it('removes pure nodes without silently reintroducing them, but cannot erase an external receipt',()=>{
    const source=run(),target=structuredClone(source.graph);target.nodes.splice(1,1);target.edges=[{id:'direct',source:'input',target:'output'}]
    expect(buildRecoveryPlan(source,'resume',target).allowed).toBe(true);expect(item(source,'work',target).reason).toContain('不再执行')
    source.graph.nodes[1]!.kind='agent';expect(item(source,'work',target).action).toBe('blocked')
  })
})

describe('stable semantic and confirmation digests',()=>{
  it('ignores labels/layout/notes and serialization order, including recursively frozen dependencies',()=>{
    const source=run(),dependency=flow();source.dependencySnapshots={child:dependency};const other=structuredClone(source)
    other.graph.title='renamed';other.graph.description='new docs';other.graph.revision++;other.graph.updatedAt='later';other.graph.notes=[{id:'note',text:'new note',x:2,y:3}];other.graph.nodes.forEach(n=>{n.x+=100;n.y-=40;n.title='renamed';n.number='display'});other.graph.nodes.reverse();other.graph.edges.reverse();other.graph.edges.forEach(e=>e.id='new visual identity');other.executions.reverse();other.executions.forEach(e=>{e.title='renamed';e.number='different'});other.dependencySnapshots!.child!.title='child renamed';other.dependencySnapshots!.child!.nodes[0]!.x=999
    expect(buildRecoveryPlan(source,'resume').planDigest).toBe(buildRecoveryPlan(other,'resume').planDigest)
    expect(workflowSemanticDigest(source.graph,{dependencySnapshots:source.dependencySnapshots})).toBe(workflowSemanticDigest(other.graph,{dependencySnapshots:other.dependencySnapshots}))
  })
  it('changes when execution state/results or frozen effective context changes',()=>{
    const source=run(),base=buildRecoveryPlan(source,'resume').planDigest
    const variants=[(s:WorkflowRun)=>{s.executions[1]!.data={text:'changed'}},(s:WorkflowRun)=>{s.executions[1]!.status='failed'},(s:WorkflowRun)=>{s.environment={key:'changed'}},(s:WorkflowRun)=>{s.modelDefaults={model:{provider:'p',model:'m'},source:'session'}},(s:WorkflowRun)=>{s.rolePrompts={work:'new role'}},(s:WorkflowRun)=>{s.toolConstraints={tool:'new contract'}},(s:WorkflowRun)=>{s.dependencySnapshots={child:flow()}},(s:WorkflowRun)=>{s.inputs.text='changed'}]
    for(const change of variants){const next=structuredClone(source);change(next);expect(buildRecoveryPlan(next,'resume').planDigest).not.toBe(base)}
    expect(buildRecoveryPlan(source,'rerun').planDigest).not.toBe(base)
  })
  it('includes arbitrary JSON context and target semantic changes but ignores unrelated audit records',()=>{
    const source=run(),target=structuredClone(source.graph),base=buildRecoveryPlan(source,'resume').planDigest;target.nodes[1]!.config.text='changed'
    expect(buildRecoveryPlan(source,'resume',target).planDigest).not.toBe(base)
    const context:unknown={extra:{b:2,a:1}};expect(workflowSemanticDigest(source.graph,context)).toBe(workflowSemanticDigest(source.graph,{extra:{a:1,b:2}}));expect(workflowSemanticDigest(source.graph,context)).not.toBe(workflowSemanticDigest(source.graph,{extra:{a:1,b:3}}))
    Object.assign(source,{snapshotRevision:2,revisions:[{at:'later'}]});expect(buildRecoveryPlan(source,'resume').planDigest).toBe(base)
  })
})

describe('effective target context changes',()=>{
  it('preserves identity-dependent successful effects only for an explicit same-run target context',()=>{
    const source=run();source.status='paused';source.systemVariables={workflow_run_id:source.id,timestamp:1792163093,session_id:'session'};source.graph.nodes[1]!.kind='http';source.graph.nodes[1]!.config={url:'https://service.test/{{sys.workflow_run_id}}',headers:{'x-session':'{{sys.session_id}}','x-time':'{{sys.timestamp}}'},cache:'reuse'}
    const target=structuredClone(source.graph);target.nodes[2]!.config.text='new display output'
    const plan=buildRecoveryPlan(source,'resume',target,{systemVariables:structuredClone(source.systemVariables)})
    expect(plan.allowed).toBe(true);expect(plan.items.find(i=>i.nodeId==='work')!.action).toBe('reuse')
    expect(buildRecoveryPlan(source,'resume').allowed).toBe(false)
    expect(buildRecoveryPlan(source,'resume',undefined,{systemVariables:source.systemVariables}).allowed).toBe(false)
    const changed=buildRecoveryPlan(source,'resume',target,{systemVariables:{...source.systemVariables,timestamp:1792164000}})
    expect(changed.allowed).toBe(false);expect(changed.items.find(i=>i.nodeId==='work')!.action).toBe('blocked');expect(changed.planDigest).not.toBe(plan.planDigest)
  })
  it('does not mistake an unchanged system snapshot for frozen wall-clock or random code',()=>{
    const source=run();source.status='paused';source.systemVariables={workflow_run_id:'run',timestamp:1};source.graph.nodes[1]!.kind='tool';source.graph.nodes[1]!.config={toolId:'builtin:time.now',cache:'reuse'}
    expect(buildRecoveryPlan(source,'resume',source.graph,{systemVariables:source.systemVariables}).items.find(i=>i.nodeId==='work')!.action).toBe('blocked')
    source.graph.nodes[1]!.kind='code';source.graph.nodes[1]!.config={code:'Date.now()',cache:'reuse'}
    expect(buildRecoveryPlan(source,'resume',source.graph,{systemVariables:source.systemVariables}).items.find(i=>i.nodeId==='work')!.action).toBe('rerun')
  })
  it('invalidates changed effective role text with an unchanged preset identity',()=>{
    const source=run();source.graph.nodes[1]!.kind='llm';source.graph.nodes[1]!.config={rolePresetId:'role',cache:'reuse'};source.rolePrompts={work:'before'}
    const plan=buildRecoveryPlan(source,'resume',source.graph,{rolePrompts:{work:'after'}})
    expect(plan.items.find(i=>i.nodeId==='work')).toMatchObject({action:'rerun',reason:expect.stringContaining('实际角色')});expect(plan.items.find(i=>i.nodeId==='input')!.action).toBe('reuse');expect(plan.planDigest).not.toBe(buildRecoveryPlan(source,'resume').planDigest)
  })
  it('invalidates only selected tool contracts and cannot replay a successful action after drift',()=>{
    const source=run();source.graph.nodes[1]!.kind='tool';source.graph.nodes[1]!.config={toolId:'native:write',cache:'reuse'};source.toolConstraints={'native:write':'old',unused:'old'}
    expect(buildRecoveryPlan(source,'resume',source.graph,{toolConstraints:{'native:write':'old',unused:'new'}}).items.find(i=>i.nodeId==='work')!.action).toBe('reuse')
    const plan=buildRecoveryPlan(source,'resume',source.graph,{toolConstraints:{'native:write':'new',unused:'old'}});expect(plan.allowed).toBe(false);expect(plan.items.find(i=>i.nodeId==='work')!.reason).toContain('工具契约')
  })
  it('includes recursively reachable child roles and tools but ignores child display-only changes',()=>{
    const source=run(),child=flow([node('childInput','input',{fields:[]}),node('call','tool',{toolId:'workflow:grandchild',cache:'reuse'})]),grandchild=flow([node('leaf','tool',{toolId:'native:read',cache:'reuse'})]);child.id='child';grandchild.id='grandchild'
    source.graph.nodes[1]!.kind='tool';source.graph.nodes[1]!.config={toolId:'workflow:child',cache:'reuse'};source.dependencySnapshots={child,grandchild};source.dependencyRolePrompts={grandchild:{leaf:'old'}};source.toolConstraints={'native:read':'old'}
    const display=structuredClone(source.dependencySnapshots);display.child!.title='rename';display.grandchild!.nodes[0]!.x=100
    expect(buildRecoveryPlan(source,'resume',source.graph,{dependencySnapshots:display}).items.find(i=>i.nodeId==='work')!.action).toBe('reuse')
    for(const context of [{dependencyRolePrompts:{grandchild:{leaf:'new'}}},{toolConstraints:{'native:read':'new'}},{dependencySnapshots:{...source.dependencySnapshots,grandchild:{...grandchild,nodes:[node('leaf','tool',{toolId:'native:read',inputs:{changed:true},cache:'reuse'})]}}}]){
      const plan=buildRecoveryPlan(source,'resume',source.graph,context);expect(plan.allowed).toBe(false);expect(plan.items.find(i=>i.nodeId==='work')!.reason).toContain('子流程')
    }
  })
  it('uses target effective environment over definitions and propagates changed input values',()=>{
    const source=run();source.graph.environmentVariables=[{id:'region',name:'REGION',type:'string',value:'old'}];source.environment={region:'old'};source.graph.nodes[1]!.config.text='{{env.region}}'
    expect(buildRecoveryPlan(source,'resume',source.graph,{environment:{region:'new'}}).items.find(i=>i.nodeId==='work')!.action).toBe('rerun')
    const plan=buildRecoveryPlan(source,'resume',source.graph,{inputs:{text:'new'}});expect(plan.items.every(i=>i.action==='rerun')).toBe(true)
  })
})

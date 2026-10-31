import {moduleCheck} from './fixtures/planning-module-check.ts'
import {describe,it,expect} from 'vitest'
import {MAIN_CHAT_GUIDE} from '../src/host/planning/main-guide.ts'
import {buildPlanningCommandBrief,moduleVerificationReceipt,planningCreateRequestSkeletons,designVerificationReceipt,PLANNING_WORKFLOW_INDEX_GUIDANCE,PLANNING_RECEIPT_GUIDANCE,PLANNING_PROPOSAL_GUIDANCE,PLANNING_ROUTE_GUIDANCE} from '../src/host/planning/command-brief.ts'
import {BUSINESS_MODULE_INSTANCE_KEY_RULE,BUSINESS_MODULE_INSTANCE_KEY_PATTERN,BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH} from '../src/shared/planning-business-module-contract.ts'
import type {PlanningTask} from '../src/host/planning/service.ts'
import {planningWaitDelta} from '../src/host/planning/wait-cursor.ts'
import {parsePlanningEntry} from '../src/host/planning/entry.ts'
import {parsePlanningRequest} from '../src/shared/planning-schema.ts'
import {businessModuleCatalog,compileBusinessModule,businessModuleRequestSchema} from '../src/shared/planning-business-modules.ts'
import {renderDataTemplate} from '../src/host/template.ts'
import {allNodes} from '../src/shared/workflow-validation.ts'
import {reviewedFileWriteGraph} from '../src/shared/planning-review-recipe.ts'
import {rewritePlanningConfig} from '../src/shared/planning-edits.ts'
import {templateContext} from './fixtures/planning-compiler/template.ts'
import {tools} from './fixtures/t18-tools.ts'

const table={moduleId:'structured-result-table',version:'1.0.0',instanceKey:'table',parameters:{title:'正文标题',columns:[{key:'value',label:'值'}]}}
const review={moduleId:'reviewed-file-write',version:'1.0.0',instanceKey:'review',parameters:{target:'report.txt',producer:{text:'正文'}}}
const scope={taskId:'task',workspaceId:'workspace',sessionId:'main'}
describe('T23 compact command brief and module receipt',()=>{
  it('uses the registry and indexes several workflows far below 8 KB without serializing configs',()=>{
    const workflows=Array.from({length:8},(_,i)=>({...templateContext().workflow,id:'flow-'+i,title:'流程 '+i}))
    workflows[0]!.nodes[0]!.config.text='PRIVATE_NODE_CONFIG_SENTINEL'
    const text=buildPlanningCommandBrief('workspace',workflows),brief=JSON.parse(text)
    expect(Buffer.byteLength(text)).toBeLessThan(8000)
    expect(text).not.toContain('PRIVATE_NODE_CONFIG_SENTINEL')
    expect(Object.keys(brief)[0]).toBe('routeRule')
    expect(text.startsWith(JSON.stringify({routeRule:PLANNING_ROUTE_GUIDANCE}).slice(0,-1))).toBe(true)
    expect(brief.source).toContain('Host')
    expect(brief.modules.map((m:any)=>m.module)).toEqual(businessModuleCatalog().map(m=>`${m.id}@${m.version}`))
    expect(brief).not.toHaveProperty('workflows');expect(brief.workflowCount).toBe(8)
    for(const module of brief.modules)for(const key of ['title','applicability','parameters','parameterExample','fixedBehaviours','humanReview','limitations'])expect(module).toHaveProperty(key)
    expect(brief.routes).toBe('路由与执行模式规则见 visible-workflows:guide。')
    expect(brief.createRequestSkeletons).toEqual(planningCreateRequestSkeletons())
    expect(brief.optionalCreateFields.title).toBe('用户给出的工作流名：已命名必传 request.title；未命名才省略')
    expect(brief.workflowIndex).toBe(PLANNING_WORKFLOW_INDEX_GUIDANCE)
    expect(brief.workflowIndex).toContain('当前 workspace+global，排除归档/其他私有图')
    expect(brief.workflowIndex).toContain('按名称/ID查找；新建不覆盖同名图，无需list核重名')
    expect(brief.verificationReceipt).toBe(PLANNING_RECEIPT_GUIDANCE)
    expect(brief.verificationReceipt).toContain('无需重读。用户需节点细节才用')
    expect(MAIN_CHAT_GUIDE).toContain('title 在用户已命名时必须照抄，未命名才按需求起简短名称')
  })
  it('advertises the exact shared instanceKey rule beside skeletons and catalog parameter examples',()=>{
    const brief=JSON.parse(buildPlanningCommandBrief('workspace',[]))
    expect(brief.createRequestSkeletons.moduleInstanceKeyRule).toBe(BUSINESS_MODULE_INSTANCE_KEY_RULE)
    expect(BUSINESS_MODULE_INSTANCE_KEY_RULE).toContain(`1–${BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH} 字符`)
    expect(BUSINESS_MODULE_INSTANCE_KEY_RULE).toContain(BUSINESS_MODULE_INSTANCE_KEY_PATTERN.source)
    // One shared rule beside all request skeletons; catalog rows do not repeat it.
    expect(brief.modules.every((row:any)=>!Object.hasOwn(row,'instanceKeyRule'))).toBe(true)
    for(const instanceKey of ['A','a_0-Z','a'.repeat(BUSINESS_MODULE_INSTANCE_KEY_MAX_LENGTH)])
      expect(()=>parsePlanningEntry({...planningCreateRequestSkeletons().module,handoff:{version:1,mode:'module',module:{...table,instanceKey}}},false)).not.toThrow()
  })
  it.each(businessModuleCatalog())('validates and materializes the catalog example for $id through the Host compiler',module=>{
    const request=businessModuleRequestSchema.parse({moduleId:module.id,version:module.version,instanceKey:'example',parameters:module.parameterExample})
    const result=compileBusinessModule(request,{...templateContext(),tools:tools()})
    expect(result.issues).toEqual([])
    expect(result.candidate).toBeDefined()
    expect(result.provenance.implementationDigest).toBe(module.implementationDigest)
    const brief=JSON.parse(buildPlanningCommandBrief('workspace',[]))
    expect(brief.modules.find((row:any)=>row.module===module.id+'@'+module.version).parameterExample).toEqual(module.parameterExample)
    if(request.moduleId==='reviewed-file-write'){
      const producer=allNodes(result.candidate!).find(node=>node.title==='produce')!
      expect(producer.config.text).toBe(request.parameters.producer.text)
      const render=(values:Record<string,string>)=>renderDataTemplate(producer.config.text!,name=>{if(!(name in values))throw Error('missing variable');return values[name]!})
      expect(render({})).toBe('这是固定初稿。')
      expect(render({reviewBase:'',reviewNote:''})).toBe('这是固定初稿。')
      expect(render({reviewBase:'上次表单正文',reviewNote:'补充结论'})).toBe('上次表单正文\n修改意见：补充结论')
      expect(render({reviewBase:'',reviewNote:'请重新起草'})).toBe('\n修改意见：请重新起草')
    }
  })
  it('validates every filled create skeleton through the real entry, planning schema and module contract',()=>{
    const shapes=planningCreateRequestSkeletons()
    for(const shape of [shapes.designOnly,shapes.executeFirst,...[table,review].map(module=>({...shapes.module,handoff:{...shapes.module.handoff,module}}))]){
      const parsed=parsePlanningEntry(shape,false)
      expect(parsed.request.operation).toBe('create')
      expect(()=>parsePlanningRequest(parsed.request)).not.toThrow()
      expect(()=>parsePlanningEntry({...shape,title:'用户工作流名称'},false)).not.toThrow()
    }
    expect(shapes.designOnly).toEqual({requestId:'stable_request_id',operation:'create',instruction:'完整需求',moduleCheck:shapes.designOnly.moduleCheck,execution:{mode:'design-only'}})
    expect(Object.keys(shapes.executeFirst.execution)).toEqual(['mode','task','tools','artifacts'])
    expect(shapes.executeFirst.execution.tools).toEqual(['read','write'])
    expect(Object.keys(shapes.module.handoff)).toEqual(['version','mode','module'])
    expect(()=>parsePlanningEntry({...shapes.designOnly,operation:undefined},false)).toThrow()
    expect(()=>parsePlanningEntry({...shapes.module,handoff:{version:1,mode:'module'}},false)).toThrow()
  })
  it('projects only exact recorded design checks and does not invent evidence for old or rejected candidates',()=>{
    const candidate=templateContext().workflow
    const task={state:'published',request:{},candidate,candidateDigest:'a'.repeat(64),diagnostics:[],receipt:{workflowId:candidate.id,revision:1,kind:'created',digest:'a'.repeat(64)},
      designChecks:{version:1,candidateDigest:'a'.repeat(64),checksPassed:['candidate-schema']},
      output:{outcome:'candidate',requirementCoverage:[{requirementId:'R1',nodeIds:[candidate.nodes[0]!.id],note:'创作覆盖声明'}],assumptions:['输入为文本'],questions:[]},
      readiness:{issues:[{message:'依赖未配置'}]},procedure:{reviewItems:['输出质量需人工复核']}} as unknown as PlanningTask
    const receipt=designVerificationReceipt(task)!
    expect(receipt.requirementCoverage).toEqual(task.output!.requirementCoverage)
    expect(receipt.checksPassed).toEqual(['candidate-schema'])
    expect(receipt.assumptions).toEqual(['输入为文本'])
    expect(receipt.unresolvedItems).toEqual(['输出质量需人工复核','依赖未配置'])
    expect(receipt.source).toContain('不是业务行为证明')
    expect(receipt.graph).toEqual({workflowId:candidate.id,revision:1,status:'saved',candidateDigest:task.candidateDigest,nodeCount:allNodes(candidate).length,nodeSummary:allNodes(candidate).map(({title,kind})=>({title,kind}))})
    expect(receipt.reporting).toBe(PLANNING_RECEIPT_GUIDANCE)
    expect(receipt).not.toHaveProperty('nodes')
    for(const patch of [{receipt:undefined},{receipt:{...task.receipt,digest:'b'.repeat(64)}},{receipt:{...task.receipt,workflowId:'another'}},{designChecks:undefined},{candidateDigest:'b'.repeat(64)},{diagnostics:[{code:'FAILED',message:'failed'}]},{state:'ready'},{request:{handoff:{mode:'module'}}}])expect(designVerificationReceipt({...task,...patch} as PlanningTask)).toBeUndefined()
    const proposed=designVerificationReceipt({...task,receipt:{...task.receipt!,kind:'proposed',proposalId:'proposal',revision:7}})!
    expect(proposed.graph).toMatchObject({revision:7,status:'proposal-pending'})
    expect(proposed.revisionMeaning).toContain('不表示修改已保存')
    expect(proposed.nextStep).toBe(PLANNING_PROPOSAL_GUIDANCE);expect(receipt.nextStep).toBeUndefined()
  })
  it.each([table,review])('uses request title for $moduleId without changing the fixed digest or implementation',module=>{
    const context={...templateContext(),tools:tools()},before=compileBusinessModule(module,context),after=compileBusinessModule(module,context,{},'用户指定工作流')
    expect(before.issues).toEqual([]);expect(after.issues).toEqual([])
    expect(after.candidate!.title).toBe('用户指定工作流')
    expect(after.provenance).toEqual(before.provenance)
    expect(after.candidate!.nodes).toEqual(before.candidate!.nodes)
    expect(before.candidate!.title).toBe(module.moduleId==='structured-result-table'?'正文标题':'审核后写入 report.txt')
    if(module.moduleId==='structured-result-table')expect(after.candidate!.nodes.find(node=>node.kind==='code')!.config.inputs!.specification).toMatchObject({title:'正文标题'})
  })
  it('reports actual module parameters, fixed behaviours and Host checks without a graph',()=>{
    const result=compileBusinessModule(review,{...templateContext(),tools:tools()})
    const task={state:'published',request:{handoff:{mode:'module',module:review}},moduleProvenance:result.provenance,candidate:result.candidate,candidateDigest:'a'.repeat(64),receipt:{workflowId:result.candidate!.id,revision:1,kind:'created',digest:'a'.repeat(64)},diagnostics:[]} as unknown as PlanningTask
    const receipt=moduleVerificationReceipt(task)!
    expect(receipt.module).toBe('reviewed-file-write@1.0.0')
    expect(receipt.parameters).toEqual(review.parameters)
    expect(receipt.implementationDigest).toBe(businessModuleCatalog()[1]!.implementationDigest)
    expect(receipt.checksPassed).toContain('REVIEW_BEFORE_EFFECT')
    expect(receipt.humanReview).toContain('human')
    expect(receipt.graph.nodeSummary).toEqual(allNodes(result.candidate!).map(({title,kind})=>({title,kind})))
    expect(receipt.graph.nodeCount).toBeGreaterThan(result.candidate!.nodes.length)
    expect(receipt.graph).toMatchObject({workflowId:result.candidate!.id,revision:1,status:'saved',candidateDigest:task.candidateDigest})
    expect(receipt.reporting).toBe(PLANNING_RECEIPT_GUIDANCE)
    expect(receipt).not.toHaveProperty('nodes')
    for(const patch of [{receipt:undefined},{state:'ready'},{candidateDigest:'b'.repeat(64)},{diagnostics:[{code:'FAILED',message:'failed'}]},{moduleProvenance:{...result.provenance,implementationDigest:'b'.repeat(64)}}])
      expect(moduleVerificationReceipt({...task,...patch} as PlanningTask)).toBeUndefined()
  })
  it.each(['report.txt','报告/结果.txt'])('T23.20：回执/简报固定事实逐字来自配方，并对应实际编译实例 %s',target=>{
    const request={...review,parameters:{...review.parameters,target}}
    const result=compileBusinessModule(request,{...templateContext(),tools:tools()})
    expect(result.issues).toEqual([])
    const task={state:'published',request:{handoff:{mode:'module',module:request}},moduleProvenance:result.provenance,candidate:result.candidate,candidateDigest:'a'.repeat(64),receipt:{workflowId:result.candidate!.id,revision:1,kind:'created',digest:'a'.repeat(64)},diagnostics:[]} as unknown as PlanningTask
    const facts=businessModuleCatalog().find(row=>row.id===review.moduleId)!.fixedFacts!
    const brief=JSON.parse(buildPlanningCommandBrief('workspace',[])),receipt=moduleVerificationReceipt(task)!
    expect(brief.modules.find((row:any)=>row.module===receipt.module).fixedFacts).toEqual(facts)
    expect(receipt.fixedFacts).toEqual(facts)
    expect(facts.reviewPromptPattern).toContain('文件只供查看，文件编辑不用于提交；修改须在表单正文中完成。拒绝时填写修改意见。')
    const recipe=reviewedFileWriteGraph({target,producer:{kind:'template',config:{text:request.parameters.producer.text}}})
    const byRole=(role:string)=>allNodes(recipe).find(node=>node.id===role)!.config
    expect(facts.reviewPromptPattern!.replace('<parameters.target>',target)).toBe(byRole('reviewGate').prompt)
    expect(facts.fields).toEqual(byRole('reviewGate').fields)
    expect(facts.actions).toEqual(byRole('reviewGate').actions)
    expect(facts.draftPathPattern!.replace('<parameters.target>',target)).toBe(byRole('draftWrite').inputs!.file_path)
    expect(facts.draftContent).toBe(byRole('draftWrite').inputs!.content)
    expect(facts.writeContent).toBe(byRole('commit').inputs!.content)
    expect(facts.fields).toContainEqual({name:'content',label:'待提交正文（在此修改）',type:'paragraph',required:false,defaultValue:'{{produce.text}}'})
    const nodes=allNodes(result.candidate!),roles=new Map(nodes.map(node=>[node.id,node.title]))
    for(const role of ['reviewGate','draftWrite','commit']){
      const node=nodes.find(node=>node.title===role)!
      const config=rewritePlanningConfig(node.config,{nodes:roles,agents:new Map(),environment:new Map()},false,node.kind)
      for(const field of role==='reviewGate'?['prompt','fields','actions']:['inputs'])expect(config[field]).toEqual(byRole(role)[field])
    }
    expect(receipt.reporting).toContain('固定行为/文案以 fixedBehaviours/fixedFacts 为准')
    expect(receipt.reporting).toContain('勿重读节点或检索安装目录/源码核验')
  })
  it('T23.20：structured-result-table 的目录、简报和回执不添加审核事实',()=>{
    const result=compileBusinessModule(table,{...templateContext(),tools:tools()})
    const task={state:'published',request:{handoff:{mode:'module',module:table}},moduleProvenance:result.provenance,candidate:result.candidate,candidateDigest:'a'.repeat(64),receipt:{workflowId:result.candidate!.id,revision:1,kind:'created',digest:'a'.repeat(64)},diagnostics:[]} as unknown as PlanningTask
    expect(businessModuleCatalog().find(row=>row.id===table.moduleId)).not.toHaveProperty('fixedFacts')
    expect(JSON.parse(buildPlanningCommandBrief('workspace',[])).modules[0]).not.toHaveProperty('fixedFacts')
    expect(moduleVerificationReceipt(task)).not.toHaveProperty('fixedFacts')
  })
  it('keeps historical requests unchanged and gives titles explicit validation',()=>{
    const old={requestId:'old',operation:'create',instruction:'原始需求'}
    expect(parsePlanningRequest(old)).toEqual(old)
    expect(parsePlanningRequest({...old,title:' 指定标题 '})).toMatchObject({title:'指定标题'})
    expect(()=>parsePlanningRequest({...old,title:' '})).toThrow()
    expect(businessModuleCatalog().map(row=>row.implementationDigest)).toEqual(['97ab7ab7732fc5cc1f22bce41bcce0b280401042345e18106513385bb9a53419','e44821bd615c8343e0729cbde3540d63be5eef7ebf9d29123a2cd0b1fc747751'])
  })
})
describe('T23 wait event cursors',()=>{
  it.each(['',' ','\t\r\n',' \u3000\u00a0 '])('treats a blank cursor %j exactly like omission',after=>{
    const view={taskId:'task',events:[{sequence:1},{sequence:2}],planning:{taskId:'linked',events:[{sequence:1}]}}
    const omitted=planningWaitDelta(view,scope),blank=planningWaitDelta(view,scope,after)
    const decode=(cursor:string)=>JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))
    expect({...blank,event_cursor:undefined}).toEqual({...omitted,event_cursor:undefined})
    expect({...decode(blank.event_cursor),waitId:undefined}).toEqual({...decode(omitted.event_cursor),waitId:undefined})
    expect(planningWaitDelta(view,scope,blank.event_cursor).events).toEqual([])
  })
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url')
  it.each([
    ['invalid base64','%%%'],['undecodable base64','A'],['noncanonical bits','Zh'],
    ['invalid JSON',Buffer.from('{').toString('base64url')],['invalid schema',encode({})],
    ['invalid version',encode({...scope,version:2,events:{},waitId:'00000000-0000-4000-8000-000000000000'})],
    ['invalid sequence',encode({...scope,version:1,events:{task:-1},waitId:'00000000-0000-4000-8000-000000000000'})],
    ['overlong','A'.repeat(16_001)],
  ])('gives a concise Chinese recovery instruction for %s',(_label,after)=>{
    expect(()=>planningWaitDelta({},scope,after)).toThrow('规划事件游标无效（event_cursor）；请不带 event_cursor 重新调用，或使用最近一次返回的 cursor。')
  })
  it('returns only unseen events and makes quiet repeated waits distinct',()=>{
    const view={taskId:'task',events:[{sequence:1},{sequence:2}],planning:{taskId:'linked',events:[{sequence:1}]}}
    const first=planningWaitDelta(view,scope),second=planningWaitDelta(view,scope,first.event_cursor)
    expect(first.events).toHaveLength(2);expect(second.events).toEqual([]);expect(second.planning.events).toEqual([])
    expect(second.event_cursor).not.toBe(first.event_cursor)
    const third=planningWaitDelta({...view,events:[...view.events,{sequence:3}]},scope,second.event_cursor)
    expect(third.events).toEqual([{sequence:3}])
    expect(view.events).toHaveLength(2)
  })
  it('scopes cursors to the exact task, session and workspace and rejects malformed cursors',()=>{
    const first=planningWaitDelta({taskId:'task'},scope)
    for(const other of [{...scope,taskId:'other'},{...scope,sessionId:'other'},{...scope,workspaceId:'other'}])expect(()=>planningWaitDelta({},other,first.event_cursor)).toThrow(/不属于/)
    expect(()=>planningWaitDelta({},scope,'invalid')).toThrow()
  })
})
describe('shared planning entry gate',()=>{
  const request={requestId:'new',operation:'create',instruction:'需求',moduleCheck}
  it('keeps execute-first default and allows only explicit design-only or read-only preview',()=>{
    expect(()=>parsePlanningEntry(request,false)).toThrow(/EXECUTION_SPEC_REQUIRED/)
    expect(parsePlanningEntry(request,true).request).toEqual(request)
    expect(parsePlanningEntry({...request,execution:{mode:'design-only'}},false).request).toEqual(request)
    expect(()=>parsePlanningEntry({...request,execution:{mode:'design-only',tools:[]}},false)).toThrow()
  })
  it('validates the same execute-first spec before any work starts',()=>{
    const execution={mode:'execute-first',task:'生成报告',tools:['write'],inputs:[],artifacts:[{path:'report.txt',format:'text',checks:[{kind:'text-includes',value:'正文'}]}],reviewItems:[]}
    expect(parsePlanningEntry({...request,execution,title:'报告流程'},false)).toMatchObject({request:{title:'报告流程'},execution:{mode:'execute-first'}})
    expect(()=>parsePlanningEntry({...request,execution:{...execution,artifacts:[]}},false)).toThrow()
    expect(()=>parsePlanningEntry({...request,execution,targetWorkflowId:'existing',operation:'revise'},false)).toThrow()
  })
})

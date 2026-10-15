/** Synthetic acceptance fixtures for the isolated, official Harness Web profile. */
import { resolve } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import type { NodeConfig, NodeGraph, NodeKind, Workflow, WorkflowNode } from '../src/shared/types.ts'

const node=(id:string,kind:NodeKind,title:string,x:number,y:number,config:NodeConfig={}):WorkflowNode=>({id,kind,title,x,y,config,fixed:false,number:''})
const edge=(source:string,target:string,port='default')=>({id:`${source}_${target}_${port}`,source,target,port})
const flow=(id:string,title:string,description:string,graph:NodeGraph):Workflow=>({id,title,description,...graph,workspaceId:'default-workspace',revision:0,notes:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})

export function validationFlows(timeToolId:string):Workflow[]{
 const inner:NodeGraph={nodes:[node('verify_item','input','当前元素',70,140,{fields:[]}),node('verify_format','template','格式化当前项',380,140,{text:'第 {{index}} 项：{{item}}'}),node('verify_each_out','output','返回本项',690,140,{text:'{{verify_format.text}}',outputName:'result'})],edges:[edge('verify_item','verify_format'),edge('verify_format','verify_each_out')]}
 const data=flow('vdw_validation_data','节点验证 · 数据处理与人工确认','无需模型：代码产生数组，列表排序，迭代逐项处理，等待确认后调用时间工具。',{
  nodes:[
   node('verify_start','input','开始',70,180,{fields:[]}),
   node('verify_code','code','生成数据',380,180,{language:'javascript',code:'function main(inputs) { return { numbers: [6, 2, 4] }; }',inputs:{},outputSchema:[{name:'numbers',type:'array',required:true}],timeoutMs:3000}),
   node('verify_list','list','升序排列',690,180,{listSource:'verify_code.numbers',sort:'asc',limit:3}),
   node('verify_iteration','iteration','逐项格式化',1000,180,{iterator:'verify_list.result',body:inner,outputVariable:'verify_each_out.text',errorMode:'terminate',parallel:false,concurrency:1}),
   node('verify_human','human','检查处理结果',1450,180,{prompt:'处理结果：\n{{verify_iteration.result}}\n确认后继续获取当前时间。',fields:[{name:'feedback',label:'备注',required:false,type:'paragraph'}],actions:[{id:'approve',label:'确认继续'},{id:'revise',label:'退回'}],timeoutSeconds:259200}),
   node('verify_time','tool','获取当前时间',1800,100,{toolId:timeToolId,inputs:{}}),
   node('verify_done','output','完成结果',2130,100,{text:'数据：{{verify_iteration.result}}\n时间：{{verify_time.text}}\n备注：{{verify_human.feedback}}',outputName:'result'}),
   node('verify_revise','output','退回结果',1800,410,{text:'用户退回，备注：{{verify_human.feedback}}',outputName:'result'}),
  ],edges:[edge('verify_start','verify_code'),edge('verify_code','verify_list'),edge('verify_list','verify_iteration'),edge('verify_iteration','verify_human'),edge('verify_human','verify_time','approve'),edge('verify_time','verify_done'),edge('verify_human','verify_revise','revise')]
 });
 const loopBody:NodeGraph={nodes:[
  node('verify_loop_start','input','循环开始',70,140,{fields:[]}),
  node('verify_add','assigner','计数加一',380,140,{assignments:[{name:'count',operation:'add',value:1}]}),
  node('verify_check','if','达到三次',690,140,{cases:[{id:'true',logic:'and',conditions:[{variable:'vars.count',operator:'gte',value:'3'}]}]}),
  node('verify_exit','exit_loop','退出循环',1010,60),
  node('verify_round','output','本轮计数',1010,320,{text:'{{vars.count}}',outputName:'count'})
 ],edges:[edge('verify_loop_start','verify_add'),edge('verify_add','verify_check'),edge('verify_check','verify_exit','true'),edge('verify_check','verify_round','false')]};
 const loop=flow('vdw_validation_loop','节点验证 · 循环与状态','每轮计数加一，第三轮命中条件后退出循环；最大次数为 5。',{
  nodes:[node('verify_counter_start','input','开始',70,180,{fields:[]}),node('verify_loop','loop','计数循环',380,180,{body:loopBody,initialVariables:{count:0},maxIterations:5,outputVariable:'vars.count'}),node('verify_counter_end','output','最终计数',900,180,{text:'最终计数：{{verify_loop.result}}；执行轮数：{{verify_loop.iterations}}',outputName:'result'})],edges:[edge('verify_counter_start','verify_loop'),edge('verify_loop','verify_counter_end')]
 });
 return[data,loop]
}

if(process.argv[1]?.endsWith('create-web-validation-flows.ts')){
 const target=process.argv[2],toolId=process.argv[3],workspaceId=process.argv[4]
 if(!target||!toolId||!workspaceId)throw new Error('需要显式指定隔离验收目录、当前时间工具 ID 和真实工作区 ID')
 if(resolve(target)!==resolve('.cache/harness-web-test/visible-dynamic-workflows'))throw new Error('仅允许写入此项目的隔离 Web 验收目录')
 const storage=new WorkflowStorage(resolve(target))
 try{for(const f of validationFlows(toolId)){f.workspaceId=workspaceId;const old=storage.workflows().find(x=>x.id===f.id);storage.save(f,old?.revision??0);console.log(f.title)}}finally{storage.close()}
}

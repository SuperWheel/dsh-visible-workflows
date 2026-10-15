/** Rendering-only graph, restricted to the isolated official Harness Web profile. */
import { resolve } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { newNode, nodePorts } from '../src/client/nodes.ts'
import type { NodeKind, Workflow } from '../src/shared/types.ts'

const target=process.argv[2],workspaceId=process.argv[3]
if(!target||!workspaceId||resolve(target)!==resolve('.cache/harness-web-test/visible-dynamic-workflows'))throw new Error('需要指定隔离 Web 验收目录及真实工作区 ID')
const kinds:NodeKind[]=['template','code','llm','if','human','iteration','loop','assigner','list','http']
const nodes=Array.from({length:200},(_,i)=>{
  const node=newNode(i===0?'input':i===199?'output':kinds[i%kinds.length]!,80+(i%20)*560,120+Math.floor(i/20)*340)
  node.id=`performance_${i}`;node.title=`${String(i+1).padStart(3,'0')} · ${node.title}`
  return node
})
const edges=nodes.slice(0,-1).flatMap((node,i)=>{const port=nodePorts(node)[0];return port?[{id:`perf_edge_${i}`,source:node.id,target:nodes[i+1]!.id,port:port.id}]:[]})
const now=new Date().toISOString()
const flow:Workflow={id:'vdw_performance_200',workspaceId,title:'性能验收 · 200 个混合节点',description:'仅用于视口裁剪与缩略图验收；包含模型、分支、循环和迭代外观，不执行模型任务。',revision:0,nodes,edges,notes:[],createdAt:now,updatedAt:now}
const storage=new WorkflowStorage(resolve(target))
try{const old=storage.workflows().find(w=>w.id===flow.id);storage.save(flow,old?.revision??0);console.log(`${flow.title}，${edges.length} 条连线`)}finally{storage.close()}

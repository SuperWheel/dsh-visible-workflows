import { describe,expect,it } from 'vitest'
import { createChainBenchmarkContext,runChainSpliceBenchmark } from '../scripts/benchmarks/planning-chain-splice.ts'
import { compilePlanningChain,planningChainView } from '../src/shared/planning-chain.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
describe('quantified local chain-splice evidence and legal graph bounds',()=>{
  it('compares twenty splices at 31/150/500/1000 without treating local CPU as a model speed gate',()=>{
    const report=runChainSpliceBenchmark({splices:20,repeats:1})
    expect(report.modelCalls).toBe(0);expect(report.algorithmCases.map(row=>row.initialNodes)).toEqual([31,150,500,1000])
    expect(report.algorithmCases.map(row=>row.aliasAssignments)).toEqual([
      {hierarchicalDuringEdits:61,hierarchicalOneConfirmation:41,eagerEverySplice:741},
      {hierarchicalDuringEdits:180,hierarchicalOneConfirmation:160,eagerEverySplice:3240},
      {hierarchicalDuringEdits:530,hierarchicalOneConfirmation:510,eagerEverySplice:10590},
      {hierarchicalDuringEdits:1030,hierarchicalOneConfirmation:1010,eagerEverySplice:21090},
    ])
    expect(report.algorithmCases.every(row=>row.orderAndFinalMappingEqual)).toBe(true)
    expect(report.candidateCases.map(row=>[row.totalNodes,row.finalTotalNodes,row.editedScopeNodes,row.issues.length])).toEqual([[31,31,31,0],[150,150,150,0],[500,500,165,0]])
    expect(report.algorithmCases[3]!.candidateLegality).toContain('algorithm-only')
  })
  it('preserves all unrelated scopes, old node numbers, layout and unchanged edge IDs in a legal 500-node candidate',()=>{
    const context=createChainBenchmarkContext(500),anchor=context.targetNodeIds[0]!,view=planningChainView(context,{anchorNodeId:anchor}),alias=view.nodes.find(node=>node.nodeId===anchor)!.alias
    const result=compilePlanningChain({version:1,baseDigest:view.baseDigest,baseRevision:view.baseRevision,anchorNodeId:anchor,operations:[{op:'replace',draftRevision:0,target:alias,nodes:[{key:'replacement',template:'template',values:{text:'New'}}]}]},context)
    expect(allNodes(result.candidate!).length).toBe(500)
    expect(result.candidate!.edges).toEqual(context.workflow.edges)
    expect(result.candidate!.nodes[1]).toEqual(context.workflow.nodes[1]);expect(result.candidate!.nodes[3]).toEqual(context.workflow.nodes[3])
    const before=new Map(allNodes(context.workflow).map(node=>[node.id,node]))
    for(const node of allNodes(result.candidate!)){const old=before.get(node.id);if(old){expect(node.number).toBe(old.number);expect(node.x).toBe(old.x);expect(node.y).toBe(old.y)}}
    const unchanged=result.candidate!.nodes[2]!.config.body!.edges.filter(edge=>edge.source!==anchor&&edge.target!==anchor&&!edge.source.startsWith('allocated-')&&!edge.target.startsWith('allocated-'))
    const oldEdges=context.workflow.nodes[2]!.config.body!.edges.filter(edge=>edge.source!==anchor&&edge.target!==anchor)
    expect(unchanged).toEqual(oldEdges)
  })
})

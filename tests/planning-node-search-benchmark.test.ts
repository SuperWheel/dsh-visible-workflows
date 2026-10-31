import { describe,expect,it } from 'vitest'
import { createNodeSearchBenchmarkFixture,NODE_SEARCH_QUERIES,runNodeSearchBenchmark } from '../scripts/benchmarks/planning-node-search.ts'
import { allNodes } from '../src/shared/workflow-validation.ts'
describe('fixed offline S08 search baseline',()=>{
  it('freezes 31 nodes with duplicate Chinese titles and five nested container levels',()=>{
    const context=createNodeSearchBenchmarkFixture(),nodes=allNodes(context.workflow)
    expect(nodes).toHaveLength(31);expect(nodes.filter(n=>n.title==='保存结果')).toHaveLength(3)
    let graph=context.workflow as typeof context.workflow|NonNullable<typeof nodes[number]['config']['body']>
    for(let depth=1;depth<=5;depth++){const container=graph.nodes.find(n=>n.id===`scope-${depth}`)!;expect(container.kind).toBe('loop');graph=container.config.body!}
    expect(graph.nodes.some(n=>n.id==='deep-final')).toBe(true);expect(NODE_SEARCH_QUERIES).toHaveLength(15)
  })
  it('records correct candidate sets, ambiguity refusals, batched dependency equality and invalidation',()=>{
    const result=runNodeSearchBenchmark()
    expect(result.summary).toMatchObject({queries:15,supportedQueries:14,supportedCorrect:14,querySetCorrect:15,ambiguityRefusals:2,wrongAutomaticSelections:0,unresolvedSemanticQueries:1})
    expect(result.queries.every(row=>row.searchRounds===1&&row.warmMatches&&row.coldMs>=0&&row.warmMs>=0)).toBe(true)
    expect(result.batch).toMatchObject({requestCount:3,readRounds:1,returnedNodes:8,individualReadRounds:3,individualReturnedNodes:13,sameDependencyUnion:true})
    expect(result.cache.hits).toBeGreaterThanOrEqual(16)
    expect(result.mutationChecks).toMatchObject({movedStableIdPreserved:true,movedScopeUpdated:true,staleIdentityRejected:true,deletedNotFound:true,deletedReadRejected:true,staleRevisionRejected:true})
    expect(result.s09Decision).toMatchObject({status:'evaluated-deferred',introduceVectors:false});expect(result.measurement.modelCalls).toBe(0)
  })
})

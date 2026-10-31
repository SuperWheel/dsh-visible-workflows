import { describe, expect, it } from 'vitest'
import { parseWorkflow } from '../src/shared/workflow-validation.ts'
import { makeWorkflow } from '../src/shared/types.ts'

function flow(timeoutMs?:unknown){const graph=makeWorkflow('workspace','Agent timeout',true);graph.nodes[1]!.kind='agent';graph.nodes[1]!.config={prompt:'task',model:{provider:'fixture',model:'fixture'},tools:[],maxSteps:3,...(timeoutMs===undefined?{}:{timeoutMs:timeoutMs as number})};return graph}
describe('Agent timeout schema',()=>{
  it('keeps the historical missing-timeout configuration unchanged',()=>{expect(parseWorkflow(flow()).nodes[1]!.config).toEqual(flow().nodes[1]!.config)})
  it.each([100,300000,3600000])('accepts a bounded timeout of %i ms',timeout=>{expect(parseWorkflow(flow(timeout)).nodes[1]!.config.timeoutMs).toBe(timeout)})
  it.each([0,99,3600001,1.5,NaN,Infinity,'1000',null])('rejects invalid timeout %s',timeout=>{expect(()=>parseWorkflow(flow(timeout))).toThrow()})
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateLogicGate } from '../src/shared/logic-gates.ts'
import { makeWorkflow, type LogicGateOperator, type WorkflowNode } from '../src/shared/types.ts'
import { assertGraph, parseWorkflow } from '../src/host/validation.ts'
import { exportWorkflowJson, importWorkflowJson } from '../src/shared/workflow-format.ts'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowRuntime } from '../src/host/runtime.ts'

const runtimes:{runtime:WorkflowRuntime;directory:string}[]=[]
afterEach(async()=>{for(const item of runtimes.splice(0)){await item.runtime.close();rmSync(item.directory,{recursive:true,force:true})}})
const gate=(operator:LogicGateOperator,values:boolean[])=>evaluateLogicGate({operator,inputs:values.map(value=>({value}))}).result
describe('explicit Boolean logic gates',()=>{
  it.each([false,true])('unary IF/ELSE and NOT evaluate %s',value=>{expect(gate('IF',[value])).toBe(value);expect(gate('NOT',[value])).toBe(!value)})
  it.each([[false,false],[false,true],[true,false],[true,true]])('binary gates have consistent truth table for %s/%s',(a,b)=>{
    expect(gate('AND',[a,b])).toBe(a&&b);expect(gate('OR',[a,b])).toBe(a||b);expect(gate('NAND',[a,b])).toBe(!(a&&b));expect(gate('NOR',[a,b])).toBe(!(a||b));expect(gate('XOR',[a,b])).toBe(a!==b);expect(gate('XNOR',[a,b])).toBe(a===b)
  })
  it('XOR uses odd parity rather than exactly one true',()=>{expect(gate('XOR',[true,true,true])).toBe(true);expect(gate('XNOR',[true,true,true])).toBe(false);expect(gate('XNOR',[true,true,false])).toBe(true)})
  it('rejects wrong arity, null and implicit text/numeric coercion even behind short circuit',()=>{
    expect(()=>gate('AND',[])).toThrow('2–32');expect(()=>gate('NOT',[true,false])).toThrow('1 个')
    for(const value of [null,'true','false',1,0,[],{}])expect(()=>evaluateLogicGate({operator:'AND',inputs:[{value:false},{value}]})).toThrow('Boolean')
  })
  it('only applies truthiness or emptiness when explicitly selected, preserving raw evidence',()=>{
    const result=evaluateLogicGate({operator:'AND',inputs:[{value:[],predicate:'truthy'},{value:0,predicate:'nonEmpty'},{value:false,predicate:'nonEmpty'}]})
    expect(result).toEqual({result:true,inputs:[[],0,false],operands:[true,true,true]})
    expect(evaluateLogicGate({operator:'IF',inputs:[{value:{},predicate:'nonEmpty'}]}).result).toBe(false)
    expect(evaluateLogicGate({operator:'IF',inputs:[{value:'false',predicate:'truthy'}]}).result).toBe(true)
    expect(evaluateLogicGate({operator:'IF',inputs:[{value:null,predicate:'falsy'}]}).result).toBe(true)
  })
  it('uses the existing branch ports and rewrites operand references on import',()=>{
    const flow=makeWorkflow('workspace',undefined,true),middle=flow.nodes[1]!
    middle.kind='if';middle.config={logicGate:{operator:'IF',inputs:[{value:`{{${flow.nodes[0]!.id}.flag}}`}]}}
    flow.edges[1]!.port='true'
    expect(()=>assertGraph(parseWorkflow(flow),true)).not.toThrow()
    const imported=importWorkflowJson(exportWorkflowJson(flow),'target').workflow
    expect(imported.nodes[1]!.config.logicGate!.inputs[0]!.value).toBe(`{{${imported.nodes[0]!.id}.flag}}`)
    middle.config.cases=[{id:'case',conditions:[{variable:'input.flag',operator:'equals',value:'true'}]}]
    expect(()=>assertGraph(flow)).toThrow('不能同时配置')
  })
  it('runs a logic gate through Graphon and records real inputs, result and selected path',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'logic-gate-runtime-')),storage=new WorkflowStorage(directory),runtime=new WorkflowRuntime(storage,{generate:async()=>{throw new Error('No model calls')}})
    runtimes.push({runtime,directory})
    const flow=makeWorkflow('workspace'),node=(id:string,kind:WorkflowNode['kind'],config:WorkflowNode['config']):WorkflowNode=>({id,kind,config,number:id,title:id,x:0,y:0,fixed:false})
    flow.nodes=[node('start','input',{fields:[{name:'flag',label:'Flag',type:'boolean',required:true}]}),node('gate','if',{logicGate:{operator:'XOR',inputs:[{value:'{{input.flag}}'},{value:true},{value:true}]}}),node('yes','output',{text:'yes',outputName:'yes'}),node('no','output',{text:'no',outputName:'no'})]
    flow.edges=[{id:'entry',source:'start',target:'gate'},{id:'yes',source:'gate',target:'yes',port:'true'},{id:'no',source:'gate',target:'no',port:'false'}]
    const saved=storage.save(flow,0),result=await runtime.settle(runtime.start(saved.id,{flag:'true'}).id)
    expect(result.status).toBe('success');expect(result.outputs).toEqual({yes:'yes'})
    const execution=result.executions.find(item=>item.nodeId==='gate')!
    expect(execution.selectedPort).toBe('true');expect(execution.data?.result).toBe(true);expect(execution.data?.inputs).toEqual([true,true,true]);expect(result.executions.find(item=>item.nodeId==='no')!.status).toBe('skipped')
  })
})

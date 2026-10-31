import { describe,expect,it } from 'vitest'
import { compilePlanningEdits,planningEditDigest } from '../src/shared/planning-edits.ts'
import { TemplateFillingCompiler } from '../src/shared/planning-template-compiler.ts'
import { referenceScopeIssues } from '../src/shared/reference-scope.ts'
import { renderDataTemplate } from '../src/host/template.ts'
import type { PlanningContext } from '../src/shared/planning-types.ts'
import type { Workflow,WorkflowNode } from '../src/shared/types.ts'
const bad='Hello {{name | trim | default("UNKNOWN", true) | upper}}'
const valid='Hello {{input.name | trim | default("UNKNOWN", true) | upper}}'
function context(text=valid,inputs?:WorkflowNode['config']['inputs']):PlanningContext {
 const workflow:Workflow={id:'flow',workspaceId:'workspace',title:'Greeting',description:'',revision:1,createdAt:'2026-10-20T00:00:00.000Z',updatedAt:'2026-10-20T00:00:00.000Z',notes:[],nodes:[
  {id:'start',number:'a-1',kind:'input',title:'Input',x:0,y:0,fixed:false,config:{fields:[{name:'name',label:'Name',required:false}]}},
  {id:'greet',number:'b-1',kind:'template',title:'Greeting',x:1,y:0,fixed:false,config:{text,...(inputs?{inputs}:{})}},
  {id:'end',number:'c-1',kind:'output',title:'Output',x:2,y:0,fixed:false,config:{text:'{{greet.text}}',outputName:'result'}},
 ],edges:[{id:'first',source:'start',target:'greet'},{id:'last',source:'greet',target:'end'}]}
 return {workflow,operation:'revise',targetNodeIds:['greet'],contextSelection:{targetNodeIds:['greet'],targetFields:{greet:['text']}},nodeIds:[],subagentIds:[],environmentIds:[],model:{provider:'offline',model:'test'},tools:[]}
}
function direct(text:string,ctx=context()) {return compilePlanningEdits({protocolVersion:1,baseDigest:planningEditDigest(ctx.workflow),outcome:'candidate',edits:[{op:'update-node',node:'@2',configSet:{text}}]},ctx)}
describe('declared workflow inputs are not implicit bare template aliases',()=>{
 it('rejects the observed default-masked B5 bare input in the direct edit compiler',()=>{
  const result=direct(bad)
  expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_REFERENCE',nodeId:'greet',message:expect.stringContaining('input.name')})]))
 })
 it('also rejects the same reference through the focused template-fill compiler',()=>{
  const result=new TemplateFillingCompiler(context()).submit({submission:{mode:'edit',updates:{n2:{values:{text:bad}}},coverage:{R1:['n2']}}})
  expect(result.ok).toBe(false)
  if(!result.ok)expect(JSON.stringify(result)).toContain('input.name')
 })
 it.each([valid,'Hello {{start.name | trim | default("UNKNOWN", true) | upper}}'])('accepts an explicit producer reference: %s',text=>{
  expect(direct(text).issues).toEqual([])
 })
 it('keeps the exact optional-name business behavior with the explicit input reference',()=>{
  for(const [name,expected]of [[' Ada ','Hello ADA'],['Grace','Hello GRACE'],['  ','Hello UNKNOWN'],[undefined,'Hello UNKNOWN']]){
   expect(renderDataTemplate(valid,path=>path==='input.name'?name:undefined)).toBe(expected)
   expect(renderDataTemplate(bad,()=>undefined)).toBe('Hello UNKNOWN')
  }
 })
 it('preserves explicit template input aliases and loop locals which shadow a declared input field',()=>{
  expect(direct(bad,context(valid,{name:'{{input.name}}'})).issues).toEqual([])
  const text='{% for name in ["Ada"] %}{{name | upper}}{% else %}{{input.name | default("UNKNOWN")}}{% endfor %}'
  expect(direct(text).issues).toEqual([])
  expect(renderDataTemplate(text,()=>undefined)).toBe('ADA')
 })
 it('preserves optional unknown roots, quoted text and normal non-planning missing-value behavior',()=>{
  expect(direct('{{missing | default("fallback")}}/{{"name"}}/{# {{name}} #}').issues).toEqual([])
  expect(referenceScopeIssues(context(bad).workflow)).toEqual([])
 })
 it('does not turn an input field name into a ban on a real upstream node identity',()=>{
  const ctx=context();ctx.workflow.nodes[0]!.config.fields=[{name:'start',label:'Start',required:false}]
  expect(direct('{{start.name | default("fallback")}}',ctx).issues).toEqual([])
 })
})

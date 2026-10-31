import type { PlanningContext } from '../../../src/shared/planning-types.ts'
export function templateContext():PlanningContext {
  return {workflow:{id:'flow',workspaceId:'workspace',title:'流程',description:'',revision:0,createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',nodes:[
    {id:'host-start',kind:'input',title:'输入',number:'1',x:0,y:0,fixed:false,config:{fields:[]}},
    {id:'host-end',kind:'output',title:'输出',number:'2',x:200,y:0,fixed:false,config:{text:'',outputName:'result'}},
  ],edges:[{id:'old-edge',source:'host-start',target:'host-end'}],notes:[]},operation:'create',targetNodeIds:[],nodeIds:Array.from({length:150},(_,i)=>'allocated-'+i),subagentIds:['role-1'],environmentIds:['env-1'],model:{provider:'offline',model:'test'},tools:[]}
}
export function filling():any {return {submission:{mode:'create',title:'问候',forms:[
  {key:'start',template:'input',values:{fields:[{name:'name',label:'姓名',required:true}]}},
  {key:'greet',template:'template',values:{text:'你好 {{input.name}}'}},
  {key:'result',template:'output',values:{text:'{{greet.text}}',outputName:'result'}},
],chains:[{key:'main',nodes:['start','greet','result']}],coverage:{R1:['greet','result']}}}}

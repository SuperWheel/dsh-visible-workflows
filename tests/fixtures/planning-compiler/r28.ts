import { readFileSync } from 'node:fs'

// Only the rejected condition and checkpoint facts are retained from Desktop r28.
export const r28=JSON.parse(readFileSync(new URL('./t24-r28-schema-rejection.json',import.meta.url),'utf8'))
export function r28Filling():any {
  const values=structuredClone(r28.guardValues)
  // Replace unrelated HTTP/tool nodes with typed input fields for offline replay.
  values.cases[0].conditions[0].variable='input.status_code'
  values.cases[0].conditions[1].variable='input.count'
  return {submission:{mode:'create',title:'条件检查',forms:[
    {key:'start',template:'input',values:{fields:[{name:'status_code',label:'状态码',type:'number',required:true},{name:'count',label:'数量',type:'number',required:true}]}},
    {key:'guard',template:'if',values},
    {key:'result',template:'output',values:{text:'检查完成'}},
  ],chains:[{key:'main',nodes:['start','guard']}],links:[{key:'passed',source:'guard',target:'result',port:'ok'},{key:'failed',source:'guard',target:'result',port:'false'}],coverage:{R1:['guard','result']}}}
}
export const r28Repair=(draftRevision=0)=>({submission:{mode:'repair',draftRevision,patches:[{op:'remove',path:'/formsByKey/guard/values/cases/0/conditions/1/gte'}]}})
export function r28Corrected(){const wire=r28Filling();delete wire.submission.forms[1].values.cases[0].conditions[1].gte;return wire}

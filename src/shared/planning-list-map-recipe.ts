import type { FragmentRecipe } from './planning-module-fragment-contract.ts'

// Iteration owns ordered collection. This adapter only names the public ports;
// it never evaluates per-item business logic or implements a second collector.
const projection = {
  language:'javascript',
  code:`function main(inputs) {
  return {texts:inputs.texts,count:inputs.results.length};
}`,
  outputSchema:[{name:'texts',type:'string',required:true},{name:'count',type:'number',required:true}],
  timeoutMs:1500,
}
export function listMapRecipe(parameters:Record<string,unknown>):FragmentRecipe {
  return {
    entry:'iterate',exit:'project',
    nodes:{
      iterate:{kind:'iteration',config:{iterator:String(parameters.items).slice(2,-2).trim(),outputVariable:'render.text',parallel:false,concurrency:3,errorMode:'terminate'}},
      render:{kind:'template',config:{text:parameters.template}},
      project:{kind:'code',config:{...structuredClone(projection),inputs:{texts:'{{iterate.text}}',results:'{{iterate.result}}'}}},
    },
    chains:{outer:{nodes:['iterate','project']},body:{container:'iterate',nodes:['render']}},
    links:{},
  }
}

import type { FragmentRecipe } from './planning-module-fragment-contract.ts'

export function webExtractRecipe(parameters:Record<string,unknown>):FragmentRecipe {
  return {entry:'fetch',exit:'extract',nodes:{
    fetch:{kind:'http',title:'HTTP 请求',config:{url:parameters.url,method:'GET',headers:{},timeoutMs:30000}},
    extract:{kind:'tool',title:'提取网页正文',config:{toolId:'builtin:html.extract_text',inputs:{html:'{{fetch.text}}',statusCode:'{{fetch.status_code}}',headers:'{{fetch.headers}}',url:parameters.url}}},
  },chains:{main:{nodes:['fetch','extract']}},links:{}}
}

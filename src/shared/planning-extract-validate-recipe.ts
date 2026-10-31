import type { FragmentRecipe } from './planning-module-fragment-contract.ts'

// Read extractor.text even when extractor's own validation failed (json is then
// absent). Keep its JSON/fence syntax, but return all field errors and a public,
// declared-fields-only object. No coercion, semantic checks or model retries.
const validation = {
  language:'javascript',
  code:`function main(inputs) {
  const errors = [], data = {};
  let value;
  try {
    value = JSON.parse(inputs.response.trim().replace(/^\x60\x60\x60(?:json)?\\s*/, '').replace(/\\s*\x60\x60\x60$/, ''));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected_object');
  } catch (_) {
    return {ok:false, data:data, errors:[{field:'', reason:'invalid_object_json'}], source:inputs.source};
  }
  for (const field of inputs.fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field.name)) {
      if (field.required) errors.push({field:field.name, reason:'required'});
      continue;
    }
    const v = value[field.name];
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    const scalar = x => typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x);
    if (type !== field.type || type === 'number' && !Number.isFinite(v)) {
      errors.push({field:field.name, reason:'expected_' + field.type});
    } else if (type === 'array' && !v.every(scalar)) {
      errors.push({field:field.name, reason:'expected_scalar_array'});
    } else {
      data[field.name] = v;
    }
  }
  return {ok:errors.length === 0, data:data, errors:errors, source:inputs.source};
}`,
  outputSchema:[{name:'ok',type:'boolean',required:true},{name:'data',type:'object',required:true},{name:'errors',type:'array',required:true},{name:'source',type:'string',required:true}],
  timeoutMs:1500,
}

export function extractValidateRecipe(parameters:Record<string,unknown>):FragmentRecipe {
  return {
    entry:'extract',exit:'validate',
    nodes:{
      extract:{kind:'extractor',config:{
        prompt:'从以下原文提取声明字段，不要编造缺失值；仅返回 JSON 对象。'+(parameters.instruction?'\n补充指令：'+parameters.instruction:'')+'\n原文：\n{{input.source}}',
        inputs:{source:parameters.source},parameters:structuredClone(parameters.fields),
      }},
      validate:{kind:'code',config:{...structuredClone(validation),inputs:{response:'{{extract.text}}',source:parameters.source,fields:structuredClone(parameters.fields)}}},
    },
    chains:{main:{nodes:['extract','validate']}},links:{},
  }
}

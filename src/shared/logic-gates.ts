import type { JsonValue, LogicGateConfig, LogicGateInput, LogicGateOperator } from './types.ts'

export const LOGIC_GATES:readonly LogicGateOperator[]=['IF','AND','OR','NOT','NAND','NOR','XOR','XNOR']
export const LOGIC_PREDICATES:readonly {id:NonNullable<LogicGateInput['predicate']>;label:string;description:string}[]=[
  {id:'boolean',label:'严格布尔值',description:'只接受 true 或 false；字符串、数字、空值报错'},
  {id:'truthy',label:'Truthy',description:'null、false、0、空字符串为假；其他 JSON 值为真（空数组与空对象为真）'},
  {id:'falsy',label:'Falsy',description:'Truthy 的取反'},
  {id:'nonEmpty',label:'非空',description:'null、空字符串、空数组、空对象为假；0 和 false 为真'},
]
export function logicGateArity(operator:LogicGateOperator):{min:number;max:number}{return operator==='IF'||operator==='NOT'?{min:1,max:1}:{min:2,max:32}}
export function validateLogicGate(config:LogicGateConfig):void {
  if(!LOGIC_GATES.includes(config.operator))throw new Error('不支持的逻辑门')
  const {min,max}=logicGateArity(config.operator)
  if(!Array.isArray(config.inputs)||config.inputs.length<min||config.inputs.length>max)throw new Error(`${config.operator} 逻辑门需要 ${min===max?min:`${min}–${max}`} 个输入`)
}
function booleanValue(value:JsonValue,predicate:NonNullable<LogicGateInput['predicate']>,index:number):boolean {
  if(predicate==='boolean'){if(typeof value!=='boolean')throw new Error(`逻辑门第 ${index+1} 项需要 Boolean；请显式选择转换规则`);return value}
  if(predicate==='truthy'||predicate==='falsy'){const truth=value!==null&&value!==false&&value!==0&&value!=='';return predicate==='truthy'?truth:!truth}
  if(predicate==='nonEmpty')return value!==null&&value!==''&&(!Array.isArray(value)||value.length>0)&&(typeof value!=='object'||Array.isArray(value)||value===null||Object.keys(value).length>0)
  throw new Error('不支持的逻辑门转换规则')
}
/** Resolve every operand before evaluation so wrong types never hide behind short circuiting. */
export function evaluateLogicGate(config:LogicGateConfig,resolveValue:(value:JsonValue)=>JsonValue=value=>value):{result:boolean;inputs:JsonValue[];operands:boolean[]} {
  validateLogicGate(config)
  const inputs=config.inputs.map(item=>resolveValue(item.value)),operands=inputs.map((value,index)=>booleanValue(value,config.inputs[index]!.predicate??'boolean',index)),truthCount=operands.filter(Boolean).length
  const result=config.operator==='IF'?operands[0]!:config.operator==='NOT'?!operands[0]:config.operator==='AND'?truthCount===operands.length:config.operator==='NAND'?truthCount!==operands.length:config.operator==='OR'?truthCount>0:config.operator==='NOR'?truthCount===0:config.operator==='XOR'?truthCount%2===1:truthCount%2===0
  return {result,inputs,operands}
}

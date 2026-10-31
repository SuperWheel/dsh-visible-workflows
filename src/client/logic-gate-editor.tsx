import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NodeConfig } from '../shared/types.ts'
import { LOGIC_GATES, LOGIC_PREDICATES, logicGateArity } from '../shared/logic-gates.ts'
import { Field, Select } from './controls.tsx'
import { Glyph } from './icons.tsx'

type Gate=NonNullable<NodeConfig['logicGate']>
export function LogicGateEditor({value,onChange,disabled=false}:{value:Gate;onChange:(next:Gate)=>void;disabled?:boolean}) {
  const arity=logicGateArity(value.operator)
  const changeOperator=(operator:Gate['operator'])=>{const limits=logicGateArity(operator),inputs=value.inputs.slice(0,limits.max);while(inputs.length<limits.min)inputs.push({value:false,predicate:'boolean'});onChange({operator,inputs})}
  const patch=(index:number,next:Partial<Gate['inputs'][number]>)=>onChange({...value,inputs:value.inputs.map((input,i)=>i===index?{...input,...next}:input)})
  return <Field label="布尔逻辑门" help="输入经过所选显式转换后求值。真走 IF，假走 ELSE；不调用模型猜测自然语言。">
    <Select label="逻辑门类型" value={value.operator} disabled={disabled} options={LOGIC_GATES.map(id=>({id,label:id}))} onChange={operator=>changeOperator(operator as Gate['operator'])}/>
    {value.operator==='XOR'||value.operator==='XNOR'?<p className="vdw-muted">XOR 在真输入数量为奇数时成立；XNOR 为其取反。</p>:null}
    {value.inputs.map((item,index)=><section className="vdw-config-group" key={index}><div className="vdw-between"><strong>输入 {index+1}</strong><Button size="sm" aria-label={`删除逻辑输入 ${index+1}`} disabled={disabled||value.inputs.length<=arity.min} onClick={()=>onChange({...value,inputs:value.inputs.filter((_,i)=>i!==index)})}><Glyph name="trash"/></Button></div>
      <Select label={`逻辑输入 ${index+1} 来源`} value={typeof item.value==='boolean'?String(item.value):'expression'} disabled={disabled} options={[{id:'false',label:'布尔值 false'},{id:'true',label:'布尔值 true'},{id:'expression',label:'变量表达式 / 文本'}]} onChange={source=>patch(index,{value:source==='expression'?'':source==='true'})}/>
      {typeof item.value!=='boolean'&&<Input aria-label={`逻辑输入 ${index+1} 值`} value={typeof item.value==='string'?item.value:JSON.stringify(item.value)} placeholder="{{节点ID.result}}" disabled={disabled} onChange={e=>patch(index,{value:e.target.value})}/>}
      <Select label={`逻辑输入 ${index+1} 转换`} value={item.predicate??'boolean'} options={LOGIC_PREDICATES.map(item=>({id:item.id,label:item.label}))} disabled={disabled} onChange={predicate=>patch(index,{predicate:predicate as Gate['inputs'][number]['predicate']})}/>
      <p className="vdw-muted">{LOGIC_PREDICATES.find(predicate=>predicate.id===(item.predicate??'boolean'))?.description}</p>
    </section>)}
    {arity.max>1&&<Button size="sm" disabled={disabled||value.inputs.length>=arity.max} onClick={()=>onChange({...value,inputs:[...value.inputs,{value:false,predicate:'boolean'}]})}>添加逻辑输入</Button>}
  </Field>
}

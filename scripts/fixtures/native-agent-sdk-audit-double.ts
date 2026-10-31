/** Explicit SDK-shaped host double for deterministic audits. No Harness process or model is contacted. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createNativeAgentExecutor, type NativeSubagentService } from '../../src/host/native-agent.ts'
import type { ToolCatalog } from '../../src/host/tool-catalog.ts'

export function nativeAgentSdkAuditDouble(catalog:ToolCatalog){
  const listeners=new Map<string,Set<(...args:any[])=>any>>(),children=new Map<string,Agent>()
  const observations={starts:0,toolCalls:0,disposed:0,host:'explicit-sdk-shaped-test-double',externalModelCalls:0}
  const ctx={on(name:string,listener:(...args:any[])=>any){const group=listeners.get(name)??new Set();group.add(listener);listeners.set(name,group);return()=>group.delete(listener)}} as unknown as Pick<Context,'on'>
  const parent={id:'audit-parent',session:{header:{delegationDepth:0}}} as unknown as Agent
  const service:NativeSubagentService={
    getProvider:()=>({inheritsParentContext:false,capabilities:{agentOptions:true,outputSchema:true,depthLimit:true,toolFilter:true,persona:true}}),
    async start(_name,request){
      const id=`audit-native-${++observations.starts}`,tools=new Map<string,ToolDefinition>()
      const child={id,session:{id,header:{parentSession:parent.id}},cancel(){},ctx:{tools:{register(definition:ToolDefinition){tools.set(definition.name,definition);return()=>tools.delete(definition.name)},guard(){return()=>{}},presentAs(){return()=>{}}},systemPrompt:{section(){return()=>{}}}}} as unknown as Agent
      children.set(id,child)
      for(const listener of listeners.get('agent/created')??[])await listener({agent:child,source:'startup'})
      let seq=0
      const emit=(type:string,data:unknown)=>{for(const listener of listeners.get('session/event')??[])listener(child.session,{seq:seq++,type,data})}
      const result=(async()=>{
        emit('subagent/descriptor',{label:request.label})
        for(const listener of listeners.get('agent/pre-step')??[]){const decision=await listener({agent:child,signal:request.signal},async()=>({kind:'enter',messages:[]}));if(decision.kind==='reject')return {stopReason:'aborted',output:[]}}
        request.signal.throwIfAborted();emit('step/start',{})
        const tool=tools.get('workflow_bound_tool_1')
        if(!tool)throw new Error('Audit requires the production native bridge for builtin:json.parse')
        const value=await tool.execute({text:'{"verified":true}'},{agent:child,signal:request.signal} as any)
        if(!(value as {json?:{verified?:boolean}}).json?.verified)throw new Error('The production builtin did not execute')
        observations.toolCalls++
        emit('assistant/message',{usage:{inputTokens:10,outputTokens:5,totalTokens:15}})
        return {stopReason:'completed',structured:{text:'agent verified'},output:[]}
      })()
      let disposed=false
      return {id,localAgent:child,result,async dispose(){await result;if(!disposed){disposed=true;observations.disposed++;children.delete(id)}}}
    },
  }
  return {observations,execute:createNativeAgentExecutor({ctx,subagents:()=>service,parentForRun:()=>parent,createParent:async()=>{throw new Error('Unexpected parent creation in SDK audit double')},nativeTools:()=>[],catalog,childForId:id=>children.get(id)})}
}

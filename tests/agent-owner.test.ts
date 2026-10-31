import {expect,it} from 'vitest'
import type {Agent,AgentRegistry} from '@deepseek-ai/dsh-agent'
import {workflowAgentOwner} from '../src/host/agent-owner.ts'

  it('uses runtime ownership for child/main scope, rejecting durable-lineage spoofing and cycles', () => {
    const main={id:'main',session:{id:'main'}},child={id:'child',session:{id:'child',header:{parentSession:'forged'}}},other={id:'other',session:{id:'other'}}
    const live=[main,child,other] as unknown as Agent[],registry={get:(id:string)=>live.find(a=>a.id===id),list:()=>live,roots:()=>[live[0],live[2]],isOwnedBy:(id:string,owner:Agent)=>id==='child'&&owner===live[0]} as Pick<AgentRegistry,'get'|'list'|'roots'|'isOwnedBy'>
    expect(workflowAgentOwner(live[1]!,registry)).toBe(live[0])
    expect(()=>workflowAgentOwner({...live[1]!} as Agent,registry)).toThrow('主对话')
    registry.isOwnedBy=()=>false;expect(()=>workflowAgentOwner(live[1]!,registry)).toThrow('主对话')
    registry.roots=()=>[];registry.isOwnedBy=(id,owner)=>id==='child'&&owner===live[0]||id==='main'&&owner===live[1]
    expect(()=>workflowAgentOwner(live[1]!,registry)).toThrow('主对话')
  })

import { useEffect, useId, useRef } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ExecutionPolicyPanel } from './execution-policy.tsx'
import { Glyph } from './icons.tsx'
import type { WorkflowStore } from './store.ts'
import { VariablePanel } from './variable-panels.tsx'
import { RolePresetsPanel } from './role-presets-panel.tsx'
import { useLocale } from './i18n.ts'

export type AdvancedSettingsTab='environment'|'system'|'policy'|'presets'
const TABS:{id:AdvancedSettingsTab;label:string;english:string}[]=[{id:'environment',label:'环境变量',english:'Environment'},{id:'system',label:'全局变量',english:'Global variables'},{id:'policy',label:'执行策略',english:'Execution policy'},{id:'presets',label:'智能体预设',english:'Agent presets'}]

/** Uses the node picker's tab and floating-surface language, without a second inspector. */
export function AdvancedSettingsPanel({store,tab,onTabChange,onClose,onLocate}:{store:WorkflowStore;tab:AdvancedSettingsTab;onTabChange:(tab:AdvancedSettingsTab)=>void;onClose:()=>void;onLocate:(id:string)=>void}) {
  const ref=useRef<HTMLElement>(null),id=useId(),{t}=useLocale()
  const close=()=>{const trigger=ref.current?.closest('.vdw')?.querySelector<HTMLButtonElement>('[data-advanced-settings-trigger],[aria-label="高级设置"],[aria-label="Advanced settings"]');onClose();trigger?.focus()}
  useEffect(()=>{
    if(typeof document==='undefined')return
    const pointer=(event:Event)=>{const target=event.target as Element;if(ref.current&&!ref.current.contains(target)&&!target.closest('[role=dialog],[role=menu],[role=listbox],[data-advanced-settings-trigger],[aria-label="高级设置"],[aria-label="Advanced settings"]'))onClose()}
    const key=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.defaultPrevented||(event.target as Element).closest('[role=dialog],[role=menu],[role=listbox]'))return;event.preventDefault();event.stopPropagation();close()}
    document.addEventListener('pointerdown',pointer);document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('pointerdown',pointer);document.removeEventListener('keydown',key)}
  },[onClose])
  return <section ref={ref} className="vdw-node-picker vdw-advanced-settings" aria-label={t('高级设置面板','Advanced settings panel')} onPointerDown={event=>event.stopPropagation()}>
    <div className="vdw-picker-heading">
      <div className="vdw-picker-tabs" role="tablist" aria-label={t('高级设置','Advanced settings')} onKeyDown={event=>{
        const index=TABS.findIndex(item=>item.id===tab),next=event.key==='ArrowRight'?(index+1)%TABS.length:event.key==='ArrowLeft'?(index+TABS.length-1)%TABS.length:event.key==='Home'?0:event.key==='End'?TABS.length-1:-1
        if(next<0)return;event.preventDefault();onTabChange(TABS[next]!.id);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()
      }}>{TABS.map(item=><button type="button" key={item.id} id={`${id}-${item.id}-tab`} role="tab" aria-controls={`${id}-${item.id}-panel`} aria-selected={tab===item.id} tabIndex={tab===item.id?0:-1} onClick={()=>onTabChange(item.id)}>{t(item.label,item.english)}</button>)}</div>
      <Tooltip label={t('关闭高级设置','Close advanced settings')} portal side="bottom" maxWidth={300}><Button size="sm" className="vdw-icon-button" aria-label={t('关闭高级设置','Close advanced settings')} onClick={close}><Glyph name="close"/></Button></Tooltip>
    </div>
    {TABS.map(item=><div key={item.id} id={`${id}-${item.id}-panel`} role="tabpanel" aria-labelledby={`${id}-${item.id}-tab`} hidden={tab!==item.id} className="vdw-advanced-content">
      {item.id==='policy'?<ExecutionPolicyPanel store={store}/>:item.id==='presets'?<RolePresetsPanel store={store}/>:<VariablePanel store={store} kind={item.id} embedded onClose={close} onLocate={onLocate}/>}
    </div>)}
  </section>
}


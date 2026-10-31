import { useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { Field, Select } from './controls.tsx'
import { setSavePreferences, useSavePreferences } from './save-preferences.ts'
import { useLocale } from './i18n.ts'

export function SaveSettings(){
  const {t}=useLocale()
  const preferences=useSavePreferences(),[minutes,setMinutes]=useState(String(preferences.intervalMinutes)),[error,setError]=useState('')
  const applyInterval=()=>{try{setSavePreferences({...preferences,intervalMinutes:Number(minutes)});setError('')}catch(e){setError(e instanceof Error?e.message:String(e))}}
  return <section className="vdw-save-settings" aria-label={t('工作流保存设置')}>
    <div className="vdw-preference-row"><div><strong>{t('保存模式')}</strong><p>{t('自动保存有修改的工作流；运行和切换流程前始终保存。','Autosave modified workflows. Changes are always saved before running or switching workflows.')}</p></div><Select label={t('工作流保存模式')} value={preferences.mode} options={[{id:'manual',label:t('手动保存')},{id:'auto',label:t('自动保存')}]} onChange={mode=>{setSavePreferences({...preferences,mode:mode as 'manual'|'auto'});setError('')}}/></div>
    <div className="vdw-preference-row"><div><strong>{t('自动保存间隔（分钟）')}</strong><p>{t('默认 5 分钟，可设置 1–1440 分钟。','Defaults to 5 minutes. Choose 1–1440 minutes.')}</p></div><Input aria-label={t('自动保存间隔（分钟）')} type="number" min={1} max={1440} step={1} value={minutes} onChange={event=>setMinutes(event.target.value)} onBlur={applyInterval} onKeyDown={event=>{if(event.key==='Enter')applyInterval()}}/></div>
    {error&&<p role="alert" className="vdw-error">{t(error)}</p>}
  </section>
}

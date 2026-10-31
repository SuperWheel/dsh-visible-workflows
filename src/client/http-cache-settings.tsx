import { useEffect, useRef, useState } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_HTTP_CACHE_SETTINGS, type HttpCacheSettings as Settings } from '../shared/http-cache-settings.ts'
import { Select } from './controls.tsx'
import { useLocale } from './i18n.ts'
import type { WorkflowStore } from './store.ts'

export function HttpCacheSettings({store}:{store:WorkflowStore}){
  const {t}=useLocale(),[settings,setSettings]=useState(DEFAULT_HTTP_CACHE_SETTINGS),[limit,setLimit]=useState('200'),[error,setError]=useState(''),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),pending=useRef(false)
  useEffect(()=>{let active=true;void store.api.httpCacheSettings().then(value=>{if(active){setSettings(value);setLimit(String(value.httpCacheLimitMB));setReady(true)}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e))});return()=>{active=false}},[store])
  const apply=async(patch:Partial<Settings>)=>{
    if(!ready||pending.current)return
    if(patch.httpCacheLimitMB!==undefined&&(!Number.isInteger(patch.httpCacheLimitMB)||patch.httpCacheLimitMB<20||patch.httpCacheLimitMB>5000)){setError(t('HTTP 响应缓存上限须为 20–5000 的整数','HTTP response cache limit must be an integer from 20 to 5000'));return}
    pending.current=true;setBusy(true);setError('')
    try{const value=await store.api.saveHttpCacheSettings(JSON.stringify(patch));setSettings(value);setLimit(String(value.httpCacheLimitMB))}catch(e){setError(e instanceof Error?e.message:String(e))}finally{pending.current=false;setBusy(false)}
  }
  return <section className="vdw-save-settings" aria-label={t('HTTP 响应缓存','HTTP response cache')}>
    <div className="vdw-preference-row"><div><strong>{t('HTTP 响应缓存上限（MB）','HTTP response cache limit (MB)')}</strong><p>{t('默认 200 MB，可设置 20–5000 MB；正在运行的数据不受上限约束。','Defaults to 200 MB. Choose 20–5000 MB; active run data is not constrained by this limit.')}</p></div><Input aria-label={t('HTTP 响应缓存上限（MB）','HTTP response cache limit (MB)')} type="number" min={20} max={5000} step={1} disabled={!ready||busy} value={limit} onChange={event=>setLimit(event.target.value)} onBlur={()=>void apply({httpCacheLimitMB:Number(limit)})} onKeyDown={event=>{if(event.key==='Enter')void apply({httpCacheLimitMB:Number(limit)})}}/></div>
    {error&&<p role="alert" className="vdw-error">{error}</p>}
    <div className="vdw-preference-row"><div><strong>{t('运行结束后立即清理 HTTP 响应缓存','Clear HTTP response cache when a run ends')}</strong><p>{t('开启后，每次运行结束都会删除所有已结束运行（含本次）的 HTTP 响应缓存，正在运行的不受影响；之后无法再查看这些运行的完整响应正文。','When enabled, every run end deletes the HTTP response cache of all finished runs, including this one; active runs are unaffected. Full response bodies of those runs can no longer be viewed.')}</p></div><Select label={t('运行结束后立即清理 HTTP 响应缓存','Clear HTTP response cache when a run ends')} disabled={!ready||busy} value={settings.httpCacheImmediateCleanup?'on':'off'} options={[{id:'off',label:t('关闭','Off')},{id:'on',label:t('开启','On')}]} onChange={value=>void apply({httpCacheImmediateCleanup:value==='on'})}/></div>
  </section>
}

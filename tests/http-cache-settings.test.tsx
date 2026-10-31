import React from 'react'
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,it,vi} from 'vitest'
import {HttpCacheSettings} from '../src/client/http-cache-settings.tsx'
import {WorkflowSettingsSection} from '../src/client/forms.tsx'
import {WorkflowStore} from '../src/client/store.ts'
import type {WorkflowAPI} from '../src/shared/types.ts'
import {setLocale} from '../src/client/i18n.ts'
import {readFileSync} from 'node:fs'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Input:'input',Button:'button',Tooltip:({children}:any)=><>{children}</>,Modal:({children}:any)=><>{children}</>}))
vi.mock('../src/client/controls.tsx',()=>({Field:({children}:any)=><>{children}</>,HelpButton:()=>null,Select:({label,value,onChange,options,disabled}:any)=><select aria-label={label} value={value} disabled={disabled} onChange={(event:any)=>onChange(event.target.value)}>{options.map((o:any)=><option key={o.id} value={o.id}>{o.label}</option>)}</select>}))
const cleanup:(()=>void)[]=[]
afterEach(()=>{cleanup.splice(0).forEach(fn=>fn());setLocale('zh-CN')})
async function mount(full=false){
  let settings={httpCacheLimitMB:200,httpCacheImmediateCleanup:false}
  const api={httpCacheSettings:vi.fn(async()=>settings),saveHttpCacheSettings:vi.fn(async(raw:string)=>settings={...settings,...JSON.parse(raw)})} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);let view!:ReactTestRenderer
  await act(async()=>{view=create(full?<WorkflowSettingsSection store={store}/>:<HttpCacheSettings store={store}/>)});cleanup.push(()=>{act(()=>view.unmount());store.dispose()});return {view,api}
}
it('uses native preference rows after autosave and a truthful bilingual footer without a Save button',async()=>{
  const {view}=await mount(true)
  const titles=view.root.findAllByProps({className:'vdw-preference-row'}).map(row=>row.findByType('strong').children.join(''))
  expect(titles).toEqual(['界面语言','保存模式','自动保存间隔（分钟）','HTTP 响应缓存上限（MB）','运行结束后立即清理 HTTP 响应缓存'])
  expect(view.root.findAllByType('button').filter(b=>b.children.includes('保存'))).toHaveLength(0)
  expect(JSON.stringify(view.toJSON())).toContain('界面语言和保存设置保存在当前浏览器；HTTP 响应缓存设置保存在本机工作流数据中')
  act(()=>setLocale('en'));expect(JSON.stringify(view.toJSON())).toContain('HTTP response cache settings are stored in local workflow data')
})
it('applies on blur/Enter or selection, rejects invalid ranges, and keeps API errors visible',async()=>{
  const {view,api}=await mount(),input=()=>view.root.findByProps({'aria-label':'HTTP 响应缓存上限（MB）'})
  for(const value of ['','19','5001','20.5']){act(()=>input().props.onChange({target:{value}}));await act(async()=>input().props.onBlur());expect(api.saveHttpCacheSettings).not.toHaveBeenCalled();expect(JSON.stringify(view.toJSON())).toContain('20–5000 的整数')}
  act(()=>input().props.onChange({target:{value:'20'}}));expect(api.saveHttpCacheSettings).not.toHaveBeenCalled()
  await act(async()=>input().props.onBlur());expect(api.saveHttpCacheSettings).toHaveBeenLastCalledWith('{"httpCacheLimitMB":20}')
  act(()=>input().props.onChange({target:{value:'5000'}}));await act(async()=>input().props.onKeyDown({key:'Enter'}));expect(input().props.value).toBe('5000')
  await act(async()=>view.root.findByType('select').props.onChange({target:{value:'on'}}));expect(api.saveHttpCacheSettings).toHaveBeenLastCalledWith('{"httpCacheImmediateCleanup":true}')
  vi.mocked(api.saveHttpCacheSettings).mockRejectedValueOnce(Error('fixture storage error'))
  await act(async()=>view.root.findByType('select').props.onChange({target:{value:'off'}}));expect(view.root.findByProps({role:'alert'}).children.join('')).toBe('fixture storage error');expect(view.root.findByType('select').props.value).toBe('on')
})
it('advertises matching Host/client Remote names; global settings do not use browser persistence',()=>{
  const host=readFileSync('src/host/index.ts','utf8'),client=readFileSync('src/client/index.tsx','utf8'),ui=readFileSync('src/client/http-cache-settings.tsx','utf8')
  for(const method of ['httpCacheSettings','saveHttpCacheSettings']){expect(host).toContain("@Remote('"+method+"')");expect(client).toContain('remote.'+method+'(')}
  expect(ui).not.toMatch(/localStorage|sessionStorage/)
})

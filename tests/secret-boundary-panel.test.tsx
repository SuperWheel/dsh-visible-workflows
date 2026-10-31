import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { VariablePanel } from '../src/client/variable-panels.tsx'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type WorkflowAPI } from '../src/shared/types.ts'
import { nativeSecretBoundaryReport, parseSecretBoundaryReport, unavailableSecretBoundaryReport } from '../src/shared/secret-boundary.ts'
import { osSecretStorageReport } from '../src/shared/os-secret-storage.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Input: 'input', Tooltip: ({ children }: any) => <>{children}</> }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const report = () => unavailableSecretBoundaryReport({ credentials: 'local-file', sandbox: 'file-policy-only', toolGuard: 'present', broker: 'missing' })
function renderedText(renderer: ReactTestRenderer): string {
  const text = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.children ? text(node.children) : ''
  return text(renderer.toJSON()) + renderer.root.findAllByType('input').map(input => String(input.props.value ?? '')).join(' ')
}
async function panel(load: NonNullable<WorkflowAPI['secretBoundary']>,manage?:NonNullable<WorkflowAPI['openSecretManager']>) {
  const api = { secretBoundary: vi.fn(load),...(manage?{openSecretManager:vi.fn(manage)}:{}) } as unknown as WorkflowAPI
  const store = new WorkflowStore(api); cleanups.push(() => store.dispose())
  const flow = makeWorkflow('workspace'); flow.environmentVariables = [{ id: 'private', name: 'TOKEN', type: 'secret' }]
  store.update({ workflow: flow, environmentDraft: { id: 'private', name: 'TOKEN', type: 'secret', value: 'stale-secret', description: '', required: false, configured: true } })
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<VariablePanel store={store} kind="environment" onClose={() => {}} onLocate={() => {}} />) })
  cleanups.push(() => act(() => renderer.unmount()))
  return { renderer, api, store }
}

it('requests live Host checks when ENV opens and keeps Secret value input absent', async () => {
  const { renderer, api } = await panel(async () => report())
  expect(api.secretBoundary).toHaveBeenCalledOnce()
  const checks = renderer.root.findByProps({ 'aria-label': 'Secret 隔离检查' })
  expect(checks.findAllByType('li')).toHaveLength(5)
  expect(renderedText(renderer)).toContain('read-only 不等于禁止读取密钥')
  expect(renderer.root.findAllByProps({ 'aria-label': '环境变量值' })).toHaveLength(0)
  expect(renderedText(renderer)).not.toContain('stale-secret')
  const refresh = checks.findAllByType('button').find(button => button.children.includes('重新检查'))!
  await act(async () => refresh.props.onClick())
  expect(api.secretBoundary).toHaveBeenCalledTimes(2)
})

it('shows a fixed failure state without leaking a remote exception', async () => {
  const { renderer } = await panel(async () => { throw new Error('/private/credential-path secret-value') })
  const text = renderedText(renderer)
  expect(text).toContain('密钥存储暂不可用；字符型和数字型变量可照常使用')
  expect(renderer.root.findByProps({ className: 'vdw-secret-status' }).props.open).not.toBe(true)
  expect(renderer.root.findByProps({ 'aria-label': '管理 TOKEN 凭据' }).props.disabled).toBe(true)
  expect(text).not.toContain('/private/credential-path')
  expect(text).not.toContain('secret-value')
  expect(renderer.root.findAllByProps({ 'aria-label': '环境变量值' })).toHaveLength(0)
})

it('does not render provider-supplied report text or accept a forged ready flag', async () => {
  const raw = report(); raw.summary = 'must-not-render'; raw.checks[0]!.detail = '/private/must-not-render'
  const { renderer, store } = await panel(async () => raw)
  expect(renderedText(renderer)).not.toContain('must-not-render')
  await act(async () => store.update({ secretBoundaryReport: { ...report(), available: true } as never }))
  expect(renderedText(renderer)).toContain('密钥存储暂不可用')
  expect(renderer.root.findByProps({ 'aria-label': '管理 TOKEN 凭据' }).props.disabled).toBe(true)
  expect(renderer.root.findByProps({ 'aria-label': 'Secret 隔离检查' }).findAllByType('li')).toHaveLength(0)
  expect(renderer.root.findAllByProps({ 'aria-label': '环境变量值' })).toHaveLength(0)
})

it('keeps native report fields closed and rebuilds all messages from protocol codes',()=>{
  const ready=nativeSecretBoundaryReport(report(),{ok:true,available:true,code:'available'})
  expect(ready).toMatchObject({schemaVersion:2,available:true,status:'available',nativeProbe:{ok:true,available:true,code:'available'}})
  expect(ready.summary).toContain('启动检查不代表已通过真实凭据隔离验收')
  const safe=parseSecretBoundaryReport({...ready,summary:'raw-secret',checks:ready.checks.map(check=>({...check,label:'raw-secret',detail:'raw-secret'}))})
  expect(JSON.stringify(safe)).not.toContain('raw-secret')
  for(const poisoned of [
    {...ready,nativeProbe:{...ready.nativeProbe,secretRef:'raw-secret'}},
    {...ready,nativeProbe:{ok:true,available:true,code:'signing_untrusted'}},
    {...ready,nativeProbe:{ok:true,available:false,code:'available'}},
    {...ready,available:false}, {...ready,status:'unavailable'},
    {...ready,grant:'raw-secret'}, {...ready,nativeProbe:{...ready.nativeProbe,code:'custom'}},
  ])expect(()=>parseSecretBoundaryReport(poisoned)).toThrow()
  expect(()=>parseSecretBoundaryReport({...report(),available:true})).toThrow()
})

it('shows the real unsigned state with disabled management and no editable Secret value',async()=>{
  const {renderer,api}=await panel(async()=>nativeSecretBoundaryReport(report(),{ok:true,available:false,code:'signing_untrusted'}),async()=>{})
  const button=renderer.root.findByProps({'aria-label':'管理 TOKEN 凭据'})
  expect(button.props.disabled).toBe(true)
  expect(button.props.title).toContain('缺少受信任的应用签名')
  expect(renderer.root.findByProps({ 'aria-label': 'Secret 隔离检查' }).findAllByType('p').map(node=>node.children.join('')).join(' ')).toContain('缺少受信任的应用签名')
  expect(renderedText(renderer)).not.toContain('已配置')
  expect(renderer.root.findAllByProps({'aria-label':'环境变量值'})).toHaveLength(0)
  expect(renderer.root.findAllByProps({'aria-label':'复制 TOKEN 引用'})).toHaveLength(0)
  await act(async()=>button.props.onClick())
  expect(api.openSecretManager).not.toHaveBeenCalled()
})

it('flushes the saved declaration before opening the native manager and refreshes without claiming configuration',async()=>{
  const steps:string[]=[],{renderer,api,store}=await panel(async()=>nativeSecretBoundaryReport(report(),{ok:true,available:true,code:'available'}),async()=>{steps.push('manage')})
  vi.spyOn(store,'flush').mockImplementation(async()=>{steps.push('flush')})
  expect(renderedText(renderer)).toContain('在原生窗口管理')
  expect(renderedText(renderer)).not.toContain('已配置')
  const flowId=store.getSnapshot().workflow!.id
  act(()=>store.update({sessionId:'caller-session'}))
  await act(async()=>renderer.root.findByProps({'aria-label':'管理 TOKEN 凭据'}).props.onClick())
  expect(steps).toEqual(['flush','manage'])
  expect(api.openSecretManager).toHaveBeenCalledExactlyOnceWith(flowId,'private','caller-session')
  expect(api.secretBoundary).toHaveBeenCalledTimes(2)
  expect(renderedText(renderer)).toContain('凭据是否已配置由原生窗口确认')
  expect(renderer.root.findAllByProps({'aria-label':'环境变量值'})).toHaveLength(0)
  expect(renderedText(renderer)).not.toContain('stale-secret')
})

it('discards raw manager errors and refuses a changed declaration after asynchronous flush',async()=>{
  const ready=()=>nativeSecretBoundaryReport(report(),{ok:true,available:true,code:'available'})
  const failed=await panel(async()=>ready(),async()=>{throw new Error('/private/raw-secret')})
  vi.spyOn(failed.store,'flush').mockResolvedValue()
  await act(async()=>failed.renderer.root.findByProps({'aria-label':'管理 TOKEN 凭据'}).props.onClick())
  expect(renderedText(failed.renderer)).toContain('原生凭据管理未完成')
  expect(renderedText(failed.renderer)).not.toContain('/private/raw-secret')
  const changed=await panel(async()=>ready(),async()=>{})
  vi.spyOn(changed.store,'flush').mockImplementation(async()=>{changed.store.update({workflow:{...changed.store.getSnapshot().workflow!,environmentVariables:[]}})})
  await act(async()=>changed.renderer.root.findByProps({'aria-label':'管理 TOKEN 凭据'}).props.onClick())
  expect(changed.api.openSecretManager).not.toHaveBeenCalled()
})

it('does not open management if the native probe closes while the declaration is being flushed',async()=>{
  const {renderer,api,store}=await panel(async()=>nativeSecretBoundaryReport(report(),{ok:true,available:true,code:'available'}),async()=>{})
  vi.spyOn(store,'flush').mockImplementation(async()=>{store.update({secretBoundaryReport:nativeSecretBoundaryReport(report(),{ok:true,available:false,code:'signing_untrusted'})})})
  await act(async()=>renderer.root.findByProps({'aria-label':'管理 TOKEN 凭据'}).props.onClick())
  expect(api.openSecretManager).not.toHaveBeenCalled()
  expect(renderedText(renderer)).toContain('原生凭据管理未完成')
})

it('opens the OS credential manager without whole-Host isolation and keeps values out of React drafts', async () => {
  const ready = () => osSecretStorageReport('macos', { ok: true, available: true, code: 'available' })
  const { renderer, api, store } = await panel(async () => ready(), async () => {})
  vi.spyOn(store, 'flush').mockResolvedValue()
  const refresh = vi.spyOn(store, 'refreshReadiness').mockResolvedValue({ ready: true, issues: [] } as never)
  expect(renderedText(renderer)).toContain('系统凭据库已就绪')
  expect(renderedText(renderer)).toContain('不接管 DSH 启动')
  expect(renderer.root.findByProps({ 'aria-label': '管理 TOKEN 凭据' }).props.disabled).toBe(false)
  expect(renderer.root.findAllByProps({ 'aria-label': '复制 TOKEN 引用' })).toHaveLength(1)
  expect(renderer.root.findAllByProps({ 'aria-label': '环境变量值' })).toHaveLength(0)
  await act(async () => renderer.root.findByProps({ 'aria-label': '管理 TOKEN 凭据' }).props.onClick())
  expect(api.openSecretManager).toHaveBeenCalledOnce()
  expect(refresh).toHaveBeenCalledOnce()
  expect(renderedText(renderer)).not.toContain('stale-secret')
})

it('keeps unverified Windows management unavailable while ordinary variable editing stays enabled', async () => {
  const { renderer } = await panel(async () => osSecretStorageReport('windows', { ok: true, available: false, code: 'unsupported_platform' }), async () => {})
  expect(renderedText(renderer)).toContain('尚待 Windows 实机验收')
  expect(renderer.root.findByProps({ 'aria-label': '管理 TOKEN 凭据' }).props.disabled).toBe(true)
  expect(renderer.root.findAllByType('button').find(button => button.children.includes('添加环境变量'))!.props.disabled).not.toBe(true)
})

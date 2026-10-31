import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
// This development launcher runs as plain Node, outside the plugin bundle.
import { modelCredentialEnvironment, modelCredentialRefs, modelProfileOverrides, pipeSafe, redactHostOutput } from '../scripts/harness-web.mjs'

const entries = [
  { id: 'ui-theme', config: { preference: 'dark' } },
  { id: 'cliworker-now', config: { custom: true } },
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { configured: { apiKeyEnv: 'CONFIGURED_API_KEY', models: [{ id: 'chosen' }] } } } },
  { id: 'agent-default-model', config: { provider: 'configured', model: 'chosen', reasoningEffort: 'high' } },
]

describe('真正 DSH Web 复用宿主模型（不发送模型请求）', () => {
  it('只复制模型路由和默认选择，不引入桌面布局或其他插件状态', () => {
    const copied = modelProfileOverrides(entries)
    expect(copied.map((entry: { id: string }) => entry.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
    expect(copied[1].config).toEqual(entries[3]!.config)
    expect(copied[0].config).not.toBe(entries[2]!.config)
    expect(modelCredentialRefs(copied)).toEqual(['CONFIGURED_API_KEY'])
  })
  it('凭证仅进入子进程环境；尊重显式环境覆盖且不借用登录会话或无关凭证', () => {
    const stored = new Map([['CONFIGURED_API_KEY', 'fixture-secret'], ['UNRELATED_API_KEY', 'unrelated-secret']])
    const env = modelCredentialEnvironment(['CONFIGURED_API_KEY'], stored, { DSH_HOME: 'caller-home' })
    expect(env).toEqual({ DSH_HOME: 'caller-home', CONFIGURED_API_KEY: 'fixture-secret' })
    expect(modelCredentialEnvironment(['CONFIGURED_API_KEY'], stored, { CONFIGURED_API_KEY: 'explicit-launch' }).CONFIGURED_API_KEY).toBe('explicit-launch')
    expect(JSON.stringify(modelProfileOverrides(entries))).not.toContain('fixture-secret')
    expect(stored.size).toBe(2)
  })
  it.each([{ apiKey: 'secret' }, { headers: { Authorization: 'Bearer secret' } }, { headers: { 'X-API-Key': 'secret' } }, { baseURL: 'https://user:secret@example.com/v1' }, { baseURL: 'https://example.com/v1?api_key=secret' }])('拒绝将内联凭证写入配置，错误消息不含值 %s', config => {
    expect(() => modelProfileOverrides([{ id: 'llm-custom', config }])).toThrow('不会生成验收配置')
    try { modelProfileOverrides([{ id: 'llm-custom', config }]) } catch (error) { expect(String(error)).not.toContain('secret') }
  })
  it('主机访问链接和分块后的完整日志都在输出前去除凭证', () => {
    expect(redactHostOutput('dsh web: http://127.0.0.1:5188/?token=fixture-access-token\nprovider fixture-secret', ['fixture-secret'])).toBe('dsh web: http://127.0.0.1:5188/?token=[REDACTED]\nprovider [REDACTED]')
    expect(redactHostOutput('Authorization: Bearer fixture-secret')).toBe('Authorization: Bearer [REDACTED]')
  })
  it('跨数据块的 token 与模型凭证仍会被过滤，末尾无换行也不会泄漏', async () => {
    const source = new PassThrough(), output: string[] = []
    pipeSafe(source, { write: (text: string) => output.push(text) }, ['fixture-secret'])
    source.write('http://127.0.0.1/?tok'); source.write('en=fixture-access\nfixture-'); source.end('secret')
    await new Promise<void>(accept => source.once('end', accept))
    expect(output.join('')).toBe('http://127.0.0.1/?token=[REDACTED]\n[REDACTED]')
  })
})

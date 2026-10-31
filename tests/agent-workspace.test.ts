import { describe, expect, it } from 'vitest'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentWorkspace, sameWorkspacePath } from '../src/host/agent-workspace.ts'

// Unit-only SDK shapes; the installed-Harness probe separately validates the
// real registry and official in-process spawn provider with zero model calls.
function fixture() {
  const live = new Map<string, Agent>(), owner = new Map<string, Agent>()
  const registry = { get: (id: string) => live.get(id), isOwnedBy: (id: string, parent: Agent) => owner.get(id) === parent } as Pick<AgentRegistry,'get'|'isOwnedBy'>
  function create(id: string, parent?: Agent, overrides: Record<string, unknown> = {}) {
    const agent = { id, session: { id, header: { cwd: '/workspace/a', ...(parent ? { origin: 'subagent', parentSession: parent.id } : {}), ...overrides } } } as unknown as Agent
    live.set(id, agent); if (parent) owner.set(id, parent)
    return agent
  }
  const main = create('main'), other = create('other', undefined, { cwd: '/workspace/b' })
  const workspaces = [{id:'a',path:'/workspace/a',sessionIds:['main']},{id:'b',path:'/workspace/b',sessionIds:['other']}]
  const resolve = (agent: Agent) => resolveAgentWorkspace(agent, workspaces, registry)
  return { live, owner, registry, create, main, other, workspaces, resolve }
}

describe('native Agent workspace inheritance', () => {
  it('preserves a registered live main and inherits only its owned native child', () => {
    const f=fixture(),child=f.create('child',f.main),grandchild=f.create('grandchild',child)
    expect(f.resolve(f.main)).toBe('a');expect(f.resolve(child)).toBe('a');expect(f.resolve(grandchild)).toBe('a')
    expect(f.workspaces[0]!.sessionIds).toEqual(['main'])
  })
  it('does not grant access from cwd or a forged durable parent header', () => {
    const f=fixture()
    expect(f.resolve(f.create('same-cwd'))).toBeUndefined()
    expect(f.resolve(f.create('forged',undefined,{origin:'subagent',parentSession:f.main.id}))).toBeUndefined()
  })
  it('does not treat a fork or arbitrary runtime child as a delegated subagent', () => {
    const f=fixture()
    expect(f.resolve(f.create('fork',f.main,{origin:undefined}))).toBeUndefined()
  })
  it('requires the exact registered child object and matching session identity', () => {
    const f=fixture(),child=f.create('child',f.main)
    expect(f.resolve({...child} as Agent)).toBeUndefined()
    const wrong=f.create('wrong',f.main);Object.assign(wrong.session,{id:'not-wrong'})
    expect(f.resolve(wrong)).toBeUndefined()
  })
  it('rejects a forged parent even when both parents are live', () => {
    const f=fixture(),child=f.create('child',f.other,{cwd:'/workspace/a',parentSession:f.main.id})
    expect(f.resolve(child)).toBeUndefined()
  })
  it('rejects cross-workspace cwd and a parent that moved workspace', () => {
    const f=fixture(),child=f.create('child',f.main,{cwd:'/workspace/b'})
    expect(f.resolve(child)).toBeUndefined()
    const same=f.create('same',f.main)
    Object.assign(f.main.session.header,{cwd:'/workspace/b'})
    expect(f.resolve(same)).toBeUndefined()
  })
  it('revokes inheritance when the parent or child is no longer live', () => {
    const f=fixture(),child=f.create('child',f.main)
    f.live.delete(f.main.id);expect(f.resolve(child)).toBeUndefined()
    f.live.set(f.main.id,f.main);f.live.delete(child.id);expect(f.resolve(child)).toBeUndefined()
  })
  it('rejects a same-id replacement parent rather than inheriting its authority', () => {
    const f=fixture(),child=f.create('child',f.main)
    f.create('main');expect(f.resolve(child)).toBeUndefined()
  })
  it('rejects cyclic lineage without reading persistent history', () => {
    const f=fixture(),one=f.create('one'),two=f.create('two',one)
    Object.assign(one.session.header,{origin:'subagent',parentSession:two.id});f.owner.set(one.id,two)
    expect(f.resolve(one)).toBeUndefined()
  })
  it('rejects ambiguous direct registrations and unregistered roots', () => {
    const f=fixture(),child=f.create('child',f.main)
    f.workspaces.push({id:'duplicate',path:'/workspace/a',sessionIds:['main']})
    expect(f.resolve(child)).toBeUndefined()
    f.workspaces.length=0;expect(f.resolve(child)).toBeUndefined()
  })
})

describe('workspace path identity', () => {
  it('matches the registered directory through symlinks and realpath aliases, like the SDK', () => {
    const root = mkdtempSync(join(tmpdir(), 'vdw-workspace-')), real = join(root, 'real'), link = join(root, 'link')
    try {
      mkdirSync(real); symlinkSync(real, link)
      expect(sameWorkspacePath(link, real)).toBe(true)
      expect(sameWorkspacePath(real + '/', realpathSync.native(real))).toBe(true)
      expect(sameWorkspacePath(join(root, 'missing'), real)).toBe(false)
      expect(sameWorkspacePath(root, real)).toBe(false)
      const agent = { id: 'main', session: { id: 'main', header: { cwd: link } } } as unknown as Agent
      expect(resolveAgentWorkspace(agent, [{ id: 'a', path: real, sessionIds: ['main'] }], { get: () => agent, isOwnedBy: () => false })).toBe('a')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

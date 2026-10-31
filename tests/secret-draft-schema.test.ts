import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStorage } from '../src/host/storage.ts'
import { WorkflowEditorState } from '../src/host/editor-state-store.ts'
import { makeWorkflow } from '../src/shared/types.ts'
import { WorkflowStore } from '../src/client/store.ts'
import { serializeEditorDraft } from '../src/client/editor-drafts.ts'
import type { WorkflowAPI } from '../src/shared/types.ts'

const cleanup:(()=>void)[]=[]
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn()})
const secret={id:'secret-id',name:'TOKEN',type:'secret',description:'declaration only',required:false,configured:false}
const synthetic='synthetic-not-a-real-credential'
function setup(){
  const directory=mkdtempSync(join(tmpdir(),'workflow-secret-draft-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}))
  const storage=new WorkflowStorage(directory);cleanup.push(()=>storage.close())
  const flow=storage.save(makeWorkflow('workspace'),0),editor=new WorkflowEditorState(storage)
  const base={id:'draft',workflowId:flow.id,workspaceId:flow.workspaceId,kind:'editor',updatedAt:''}
  return {directory,storage,flow,editor,base}
}

describe('strict Secret draft declaration boundary',()=>{
  it('returns fixed safe errors without reflecting unknown field names or submitted values',()=>{
    const f=setup(),privateKey='synthetic-sensitive-field-name'
    for(const [type,message] of [['secret','Secret 草稿只能保存声明，不能包含变量值、凭据绑定或其他额外字段'],['string','环境变量草稿格式无效，请检查字段类型和内容长度']] as const){
      const draft={...secret,type,[privateKey]:synthetic}
      try{f.editor.saveDraft({...f.base,payload:{environmentDraft:draft}},0);expect.unreachable()}catch(error){
        expect((error as Error).message).toBe(message)
        expect((error as Error).message).not.toContain(privateKey)
        expect((error as Error).message).not.toContain(synthetic)
      }
    }
    expect(()=>f.editor.saveDraft({...f.base,payload:{annotationDraft:{nested:{...secret,[privateKey]:synthetic}}}},0)).toThrow('Secret 草稿只能保存声明')
  })

  it.each(['binding','ciphertext','secretRef','rawValue','providerPath','extra'])('rejects the %s material field without changing the saved declaration',key=>{
    const f=setup(),saved=f.editor.saveDraft({...f.base,payload:{environmentDraft:secret}},0),before=readFileSync(join(f.directory,'editor-state.json'),'utf8')
    const poisoned={...secret,[key]:key==='binding'?{value:synthetic}:synthetic}
    expect(()=>f.editor.saveDraft({...saved,payload:{environmentDraft:poisoned}},1)).toThrow()
    expect(readFileSync(join(f.directory,'editor-state.json'),'utf8')).toBe(before)
    expect(JSON.stringify(f.editor.drafts(f.flow.id))).not.toContain(synthetic)
  })
  it('rejects a configured Secret and hidden Secret material inside another draft payload',()=>{
    const f=setup()
    for(const payload of [{environmentDraft:{...secret,configured:true}},{environmentDraft:{...secret,value:synthetic}},{annotationDraft:{text:'annotation',nodeIds:[],nested:{...secret,binding:{value:synthetic}}}}])expect(()=>f.editor.saveDraft({...f.base,payload},0)).toThrow()
    expect(f.editor.drafts(f.flow.id)).toEqual([])
  })
  it('accepts the real client serializer output and reloads a legal legacy declaration unchanged',()=>{
    const f=setup(),store=new WorkflowStore({} as WorkflowAPI);cleanup.push(()=>store.dispose())
    store.update({workflow:f.flow});store.update({environmentDraft:{...secret,type:'secret',value:synthetic,configured:true}})
    const draft=serializeEditorDraft(store.getSnapshot(),'draft')!
    expect(draft.payload.environmentDraft).toEqual(secret)
    const saved=f.editor.saveDraft(draft,0)
    expect(saved.payload.environmentDraft).toEqual(secret)
    const {revision:_,...legacy}=saved,bytes=JSON.stringify({proposals:[],drafts:[legacy]})
    writeFileSync(join(f.directory,'editor-state.json'),bytes)
    const reopened=new WorkflowEditorState(f.storage)
    expect(reopened.drafts(f.flow.id)[0]).toMatchObject({revision:1,payload:{environmentDraft:secret}})
    expect(readFileSync(join(f.directory,'editor-state.json'),'utf8')).toBe(bytes)
  })
  it('preserves unfinished ordinary string/number drafts and their CAS conflicts',()=>{
    const f=setup(),ordinary={id:'public-id',name:'',type:'string',description:'unfinished',required:false,configured:true,value:'ordinary config'}
    const first=f.editor.saveDraft({...f.base,payload:{environmentDraft:ordinary}},0)
    const second=f.editor.saveDraft({...first,payload:{environmentDraft:{...ordinary,type:'number',name:'1 unfinished',value:'-'}}},1)
    expect(second.revision).toBe(2);expect(second.payload.environmentDraft).toMatchObject({type:'number',value:'-'})
    expect(()=>f.editor.saveDraft({...first,payload:{environmentDraft:ordinary}},1)).toThrow('其他窗口')
    expect(f.editor.drafts(f.flow.id)[0]).toEqual(second)
  })
  it('rejects the same extra Secret fields in proposals and never adds them to an environment snapshot',async()=>{
    const f=setup(),{environmentSnapshot}=await import('../src/shared/workflow-variables.ts')
    for(const key of ['binding','ciphertext','secretRef','extra']){
      const variable={id:secret.id,name:secret.name,type:'secret',[key]:synthetic}
      expect(()=>f.editor.propose({...f.flow,environmentVariables:[variable]},f.flow.revision)).toThrow()
      expect(environmentSnapshot({environmentVariables:[variable as never]})).toEqual({})
    }
    expect(f.editor.proposals(f.flow.id)).toEqual([])
  })
})

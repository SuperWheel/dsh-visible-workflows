import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStore } from '../src/client/store.ts'
import { makeWorkflow, type LibrarySnapshot, type RolePreset, type WorkflowAPI } from '../src/shared/types.ts'
const stores:WorkflowStore[]=[]
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve}}
const role=(id:string):RolePreset=>({id,name:id,prompt:id,revision:1})
function fixture(){
  const workflow={...makeWorkflow('workspace','Editor',true),revision:1},library:LibrarySnapshot={workflows:[workflow],presets:[role('initial')],runs:[],workspaces:[]}
  const api={list:vi.fn(async()=>library),presets:vi.fn(async()=>library.presets),models:vi.fn(async()=>[])} as unknown as WorkflowAPI
  const store=new WorkflowStore(api);stores.push(store);store.update({workflow,library,page:'canvas',loading:false});store.edit({...workflow,title:'Keep unsaved editor'})
  return {store,api,library}
}
afterEach(()=>stores.splice(0).forEach(store=>store.dispose()))
describe('role catalog read ordering after successful imports',()=>{
  it('discards a slow preset read after a role save updates the catalog',async()=>{
    const {store,api}=fixture(),old=deferred<RolePreset[]>(),fresh=[role('just-saved')]
    vi.mocked(api.presets).mockReturnValueOnce(old.promise);const reading=store.refreshPresets()
    store.update({library:{...store.getSnapshot().library,presets:fresh}});old.resolve([role('stale')]);await reading
    expect(store.getSnapshot().library.presets).toEqual(fresh);expect(store.getSnapshot().workflow?.title).toBe('Keep unsaved editor');expect(store.getSnapshot().saveState).toBe('dirty')
  })
  it('keeps newer preset reads when an older full-library load returns later',async()=>{
    const {store,api,library}=fixture(),old=deferred<LibrarySnapshot>(),fresh=[role('imported-local')],editor=store.getSnapshot().workflow
    vi.mocked(api.list).mockReturnValueOnce(old.promise);const loading=store.load()
    vi.mocked(api.presets).mockResolvedValueOnce(fresh);await store.refreshPresets()
    old.resolve({...library,presets:[role('old-list')]});await loading
    expect(store.getSnapshot().library.presets).toEqual(fresh);expect(store.getSnapshot().workflow).toBe(editor);expect(store.getSnapshot().saveState).toBe('dirty')
  })
  it('discards an older preset read after a newer full-library load provides the catalog',async()=>{
    const {store,api,library}=fixture(),old=deferred<RolePreset[]>(),fresh=[role('fresh-list')]
    vi.mocked(api.presets).mockReturnValueOnce(old.promise);const reading=store.refreshPresets()
    vi.mocked(api.list).mockResolvedValueOnce({...library,presets:fresh});await store.load()
    old.resolve([role('old-role-request')]);await reading
    expect(store.getSnapshot().library.presets).toEqual(fresh);expect(store.getSnapshot().workflow?.title).toBe('Keep unsaved editor')
  })
  it('discards a pre-import refresh while applying the imported library and keeps dirty editor content intact',async()=>{
    const {store,api,library}=fixture(),old=deferred<RolePreset[]>(),fresh=[role('new-owner-role')],editor=store.getSnapshot().workflow
    vi.mocked(api.presets).mockReturnValueOnce(old.promise);const reading=store.refreshPresets()
    vi.mocked(api.presets).mockResolvedValueOnce(fresh);vi.mocked(api.list).mockResolvedValueOnce({...library,presets:fresh})
    await store.refreshImportedAssets();old.resolve([role('pre-import')]);await reading
    expect(store.getSnapshot().library.presets).toEqual(fresh);expect(store.getSnapshot().workflow).toBe(editor);expect(store.getSnapshot().saveState).toBe('dirty')
  })
  it('preserves the editor and reports a nonfatal saved-state notice when asset reads are unavailable',async()=>{
    const {store,api}=fixture(),before=store.getSnapshot()
    vi.mocked(api.list).mockRejectedValueOnce(new Error('list offline'));vi.mocked(api.presets).mockRejectedValueOnce(new Error('roles offline'))
    await expect(store.refreshImportedAssets()).resolves.toBeUndefined()
    expect(store.getSnapshot().workflow).toBe(before.workflow);expect(store.getSnapshot().saveState).toBe('dirty');expect(store.getSnapshot().library.presets).toEqual(before.library.presets)
    expect(store.getSnapshot().libraryWarning).toContain('流程已保存');expect(store.getSnapshot().error).toBe('')
  })
})

import type { Workflow } from '../shared/types.ts'
import { exportWorkflowJson } from '../shared/workflow-format.ts'
import type { WorkflowStore } from './store.ts'
import { t } from './i18n.ts'

/** Copy exactly the selected card through the portable, atomic import path.
 * The Host remaps workflow/node/preset identities and strips local bindings. */
export async function copyWorkflowCard(store:WorkflowStore,source:Workflow,title:string):Promise<Workflow>{
  if(!store.api.importPackage)throw new Error(t('当前宿主不支持复制工作流，请更新插件。','The host does not support copying workflows. Update the plugin.'))
  const before=store.getSnapshot()
  const raw=exportWorkflowJson({...structuredClone(source),title},{includeEnvironmentValues:true,presets:before.library.presets,workflows:before.library.workflows})
  // The visible/retained editor may be an entirely different workflow. Preserve
  // its changes before creating the copy, without using it as the copy source.
  await store.flushForNavigation()
  const persisted=store.getSnapshot()
  if(persisted.workflow?.id!==before.workflow?.id||persisted.sessionId!==before.sessionId)throw new Error(t('画布或对话已变化，尚未创建副本，请重试。','The canvas or conversation changed. No copy was created. Try again.'))
  const saved=await store.api.importPackage(raw,source.workspaceId,{},persisted.sessionId)
  await store.refreshImportedAssets()
  const latest=store.getSnapshot()
  const library={...latest.library,workflows:[saved,...latest.library.workflows.filter(workflow=>workflow.id!==saved.id)]}
  if(latest.workflow!==persisted.workflow||latest.sessionId!==persisted.sessionId){
    store.update({library})
    throw new Error(t('副本已创建，当前画布在等待期间有更新，已保留当前修改；可在主页打开副本。','The copy was created. Current edits made while waiting were preserved; open the copy from the workflow home.'))
  }
  // The preflight flush has made edit/persistence serials equal. Adopt the
  // imported response before open() so it cannot flush a stale source definition.
  store.update({workflow:saved,library,page:'canvas',configId:'',logs:false,annotationDraft:undefined,generateDraft:undefined,selected:[],scopePath:saved.editor?.scopePath??[],undo:[],redo:[],saveState:'saved',error:'',run:undefined,viewport:saved.editor?.viewport??{x:32,y:40,scale:1}})
  await store.open(saved.id)
  return saved
}

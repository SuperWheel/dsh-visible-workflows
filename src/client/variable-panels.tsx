import { t, useLocale } from './i18n.ts'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, type EnvironmentVariable } from '../shared/types.ts'
import { environmentVariableStatus, SECRET_UNAVAILABLE_REASON, SYSTEM_VARIABLES } from '../shared/workflow-variables.ts'
import { Field } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { useWorkflowStore, type WorkflowStore } from './store.ts'
import { environmentDraft, environmentFromDraft, environmentReferences, systemVariableValue } from './workflow-variables.ts'
import { parseSecretBoundaryReport } from '../shared/secret-boundary.ts'

const typeNames={string:'字符型',number:'数字型',secret:'密钥'}
const stateNames={configured:'已配置',missing:'未配置',unavailable:'不可用'}
export function VariablePanel({store,kind,onClose,onLocate,embedded=false}:{store:WorkflowStore;kind:'environment'|'system';onClose:()=>void;onLocate:(id:string)=>void;embedded?:boolean}) {useLocale();
  const state=useWorkflowStore(store),flow=state.workflow!,draft=state.environmentDraft
  const [search,setSearch]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[references,setReferences]=useState(''),[saving,setSaving]=useState(false),[managing,setManaging]=useState(''),managerPending=useRef(false)
  useEffect(()=>{if(kind==='environment')void store.refreshSecretBoundary()},[store,kind])
  // The report can enable opening the native manager, never a webpage Secret input or an authorization grant.
  let boundary:ReturnType<typeof parseSecretBoundaryReport>|undefined
  try{if(state.secretBoundaryReport)boundary=parseSecretBoundaryReport(state.secretBoundaryReport)}catch{}
  const nativeReady=(boundary?.schemaVersion===2||boundary?.schemaVersion===4)&&boundary.available,stateReady=state.secretBoundaryState==='ready',canManage=nativeReady&&stateReady&&!!store.api.openSecretManager
  const managerHelp=canManage?'在系统凭据窗口查看、编辑、删除及管理自动使用授权。':!store.api.openSecretManager?'当前宿主尚未提供原生凭据管理入口。':boundary?.summary??'原生凭据代理尚未通过启动检查。'
  const variables=flow.environmentVariables??[],query=search.toLowerCase(),visibleVariables=variables.filter(variable=>`${variable.name} ${variable.description??''}`.toLowerCase().includes(query))
  const edit=(variable?:EnvironmentVariable)=>{store.update({environmentDraft:environmentDraft(variable??{id:newId(),name:'',type:'string',value:''})});setError('')}
  const changeType=(type:EnvironmentVariable['type'])=>{if(!draft||draft.type===type)return;store.update({environmentDraft:{...draft,type,value:'',configured:type!=='secret'}});setError('')}
  const save=async()=>{if(!draft)return;setError('');setSaving(true);try{const variable=environmentFromDraft(draft,variables);store.edit({...flow,environmentVariables:variables.some(item=>item.id===variable.id)?variables.map(item=>item.id===variable.id?variable:item):[...variables,variable]});await store.save();store.update({environmentDraft:undefined})}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setSaving(false)}}
  const remove=async(variable:EnvironmentVariable)=>{setError('');if(environmentReferences(flow,variable.id).length){setReferences(variable.id);setError('该变量仍被节点引用，请先替换这些引用，再删除。');return}try{store.edit({...flow,environmentVariables:variables.filter(item=>item.id!==variable.id)});await store.save();if(draft?.id===variable.id)store.update({environmentDraft:undefined})}catch(e){setError(String(e))}}
  const manage=async(variable:EnvironmentVariable)=>{
    if(!canManage||managerPending.current||variable.type!=='secret')return
    const intent={workflowId:flow.id,workspaceId:flow.workspaceId,variableId:variable.id,sessionId:state.sessionId}
    managerPending.current=true;setManaging(variable.id);setError('');setFeedback('')
    try{
      await store.flush()
      const current=store.getSnapshot(),selected=current.workflow
      let ready=false
      try{const latest=parseSecretBoundaryReport(current.secretBoundaryReport);ready=(latest.schemaVersion===2||latest.schemaVersion===4)&&latest.available&&current.secretBoundaryState==='ready'}catch{}
      if(current.sessionId!==intent.sessionId||selected?.id!==intent.workflowId||selected.workspaceId!==intent.workspaceId||!selected.environmentVariables?.some(item=>item.id===intent.variableId&&item.type==='secret')||!ready||!store.api.openSecretManager)throw new Error('管理目标已变化')
      await store.api.openSecretManager(intent.workflowId,intent.variableId,intent.sessionId)
      await store.refreshSecretBoundary()
      if(store.getSnapshot().workflow?.id===intent.workflowId)await store.refreshReadiness().catch(()=>{})
      if(store.getSnapshot().workflow?.id===intent.workflowId)setFeedback('凭据管理窗口已关闭。凭据是否已配置由原生窗口确认；画布不会接收密钥原值。')
    }catch{
      if(store.getSnapshot().workflow?.id===intent.workflowId)setError('原生凭据管理未完成。请检查流程保存状态和代理启动检查后重试；没有回退到网页或文件存储。')
    }finally{managerPending.current=false;setManaging('')}
  }
  const copy=async(reference:string)=>{try{await navigator.clipboard.writeText(reference);setFeedback('已复制引用')}catch{setFeedback(`复制失败，可选择此引用复制：${reference}`)}}
  const title=kind==='environment'?t('环境变量'):t('全局变量')
  return <aside className={`vdw-variable-panel${embedded?' is-embedded':''}`} aria-label={title} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose()}}}>
    {!embedded&&<header><strong>{title}</strong><Button size="sm" aria-label={t('关闭{title}','Close {title}',{title})} onClick={onClose}><Glyph name="close"/></Button></header>}
    <div className="vdw-config-body">
      <p className="vdw-variable-panel-intro">{kind==='environment'?t("字符型和数字型用于公共配置，流程与 Agent 均可读取。密钥保存在系统凭据库，Agent 只能通过受控操作引用。"):t("这些系统变量由宿主和运行时提供，只读且无需连线即可在流程内引用。运行期字段在执行时生成。")}</p>
      <Input className="vdw-variable-panel-search" aria-label={t('搜索{title}','Search {title}',{title})} placeholder={t("搜索名称或说明")} value={search} onChange={e=>setSearch(e.target.value)}/>
      {kind==='environment'?<>
        <Button className="vdw-variable-panel-add" variant="primary" icon={<Glyph name="plus"/>} onClick={()=>edit()}>{t("添加环境变量")}</Button>
        {draft&&<section className="vdw-config-group vdw-environment-editor" aria-label={t("环境变量编辑")}><div className="vdw-between"><strong>{variables.some(v=>v.id===draft.id)?t("编辑变量"):t("新增变量")}</strong><small>{state.draftSaveState==='saved'?t("草稿已保存"):state.draftSaveState==='error'?t("草稿保存失败"):t("未应用的草稿")}</small></div>
          <Field label={t("类型")}><div className="vdw-environment-type-options" role="radiogroup" aria-label={t("环境变量类型")} onKeyDown={event=>{const types=Object.keys(typeNames) as EnvironmentVariable['type'][],index=types.indexOf(draft.type),next=event.key==='ArrowRight'||event.key==='ArrowDown'?(index+1)%types.length:event.key==='ArrowLeft'||event.key==='ArrowUp'?(index+types.length-1)%types.length:-1;if(next<0)return;event.preventDefault();changeType(types[next]!);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus()}}>{(Object.entries(typeNames) as [EnvironmentVariable['type'],string][]).map(([type,label])=><button type="button" key={type} role="radio" aria-checked={draft.type===type} tabIndex={draft.type===type?0:-1} onClick={()=>changeType(type)}>{type==='secret'&&<Glyph name="lock" size={14}/>} {t(label)}</button>)}</div></Field>
          <Field label={t("名称")}><Input aria-label={t("环境变量名称")} value={draft.name} placeholder="API_BASE_URL" onChange={e=>store.update({environmentDraft:{...draft,name:e.target.value}})}/></Field>
          {draft.type==='secret'?<p className="vdw-secret-unavailable" role="note"><Glyph name="lock"/>{nativeReady?t("这里只保存变量声明。保存后可在系统凭据窗口管理原值和自动使用授权；密钥及本机授权不会返回画布或随 JSON 导出。"):boundary?.schemaVersion===2||boundary?.schemaVersion===4?boundary.summary:`${SECRET_UNAVAILABLE_REASON}。可以保存定义，当前不能录入真实密钥。`}</p>:<>
            <label className="vdw-check-field"><input type="checkbox" checked={draft.configured} onChange={e=>store.update({environmentDraft:{...draft,configured:e.target.checked}})}/>{t("为变量设置值")}</label>
            {draft.configured&&<Field label={t("值")}><Input aria-label={t("环境变量值")} type={draft.type==='number'?'number':'text'} value={draft.value} onChange={e=>store.update({environmentDraft:{...draft,value:e.target.value}})}/></Field>}
            <p className="vdw-muted">{t("普通值可被 Agent 读取。请勿在此填写 API 密钥或密码。")}</p>
          </>}
          <Field label={t("说明")}><textarea aria-label={t("环境变量说明")} rows={2} value={draft.description} onChange={e=>store.update({environmentDraft:{...draft,description:e.target.value}})}/></Field>
          <label className="vdw-check-field"><input type="checkbox" checked={draft.required} onChange={e=>store.update({environmentDraft:{...draft,required:e.target.checked}})}/>{t("运行前必须配置")}</label>
          <div className="vdw-actions"><Button onClick={()=>store.update({environmentDraft:undefined})} disabled={saving}>{t("取消")}</Button><Button variant="primary" disabled={saving||!draft.name.trim()} onClick={()=>void save()}>{saving?t("保存中…"):t("保存")}</Button></div>
        </section>}
        {!!visibleVariables.length&&<div className="vdw-variable-panel-list">{visibleVariables.map(variable=>{const used=environmentReferences(flow,variable.id);return <section key={variable.id} className="vdw-variable-card"><header className="vdw-variable-toolbar"><strong title={variable.name}>{variable.name}</strong><span className="vdw-variable-type">{t(typeNames[variable.type])}</span></header><div className="vdw-variable-panel-content"><p>{variable.description||t('未填写说明')}</p><small>{variable.type==='secret'?(canManage?'在原生窗口管理':'不可用'):t(stateNames[environmentVariableStatus(variable)])}{variable.required?t(" · 必需"):''}</small>{variable.type!=='secret'&&variable.value!==undefined&&<code className="vdw-variable-current-value">{String(variable.value)||t('空字符串')}</code>}<div className="vdw-actions"><Button size="sm" onClick={()=>edit(variable)}>{t("编辑")}</Button>{variable.type==='secret'&&<Tooltip side="bottom" maxWidth={300} label={t(managerHelp)} portal><Button size="sm" aria-label={t('管理 {name} 凭据','Manage {name} credential',{name:variable.name})} title={t(managerHelp)} disabled={!canManage||!!managing||saving} onClick={()=>void manage(variable)}>{managing===variable.id?t("正在管理…"):t("管理凭据")}</Button></Tooltip>}<Button size="sm" onClick={()=>setReferences(references===variable.id?'':variable.id)}>{t("引用")}{used.length}</Button>{(variable.type!=='secret'||boundary?.schemaVersion===4)&&<Tooltip side="bottom" maxWidth={300} label={variable.type==='secret'?t("复制 Secret 声明 ID；在受控凭据操作中引用，不可插入提示词"):t("复制稳定引用；重命名后仍有效")} portal><Button size="sm" className="vdw-icon-button" aria-label={t('复制 {name} 引用','Copy {name} reference',{name:variable.name})} onClick={()=>void copy(variable.type==='secret'?variable.id:`{{env.${variable.id}}}`)}><Glyph name="copy"/></Button></Tooltip>}<Button size="sm" className="vdw-icon-button" aria-label={t('删除 {name}','Delete {name}',{name:variable.name})} onClick={()=>void remove(variable)}><Glyph name="trash"/></Button></div>{references===variable.id&&<div className="vdw-variable-references">{used.length?used.map(node=><Button key={node.id} size="sm" onClick={()=>onLocate(node.id)}>{node.number} · {node.title}</Button>):<small>{t("没有节点引用此变量。")}</small>}</div>}</div></section>})}</div>}
        {!variables.length&&!draft&&<p className="vdw-muted">{t("尚无环境变量。添加公共地址、超时值等可复用配置。")}</p>}
        <details className="vdw-secret-status"><summary>{t("密钥存储状态 ·")}{nativeReady?t("已就绪"):state.secretBoundaryState==='loading'?t("检查中"):t("未就绪")}</summary><section className="vdw-config-group" aria-label={t("Secret 隔离检查")}>
          <div className="vdw-between"><strong><Glyph name="lock"/> {t("系统凭据库")}</strong><Button size="sm" disabled={state.secretBoundaryState==='loading'} onClick={()=>void store.refreshSecretBoundary()}>{state.secretBoundaryState==='loading'?t("检查中…"):t("重新检查")}</Button></div>
          <p className="vdw-muted">{boundary?.summary??(state.secretBoundaryState==='loading'?'正在检查密钥存储能力；字符型和数字型变量可照常使用。':'密钥存储暂不可用；字符型和数字型变量可照常使用。')}</p>
          {boundary&&<details><summary>{t("查看")}{boundary.checks.length} {t("项检查")}</summary><ul>{boundary.checks.map(check=><li key={check.id}><strong>{check.label} · {check.status==='observed'?(boundary.schemaVersion===4?'已检查':'已检测到接口'):check.status==='missing'?t("缺少能力"):t("未通过核验")}</strong><p className="vdw-muted">{check.detail}</p></li>)}</ul><small>{t("检查时间：")}{boundary.checkedAt}；{boundary.schemaVersion===4?t("组件就绪不代表已配置或授权；授权后可自动运行，管理密钥时验证本人身份。"):t("接口存在不等于隔离已通过。")}</small></details>}
        </section></details>
      </>:<>
        {state.run&&<p className="vdw-muted">{t("所选运行：")}<code>{state.run.id}</code></p>}
        <div className="vdw-variable-panel-list">{SYSTEM_VARIABLES.filter(variable=>`${variable.name} ${variable.label} ${variable.description}`.toLowerCase().includes(query)).map(variable=><section className="vdw-variable-card" key={variable.name}><header className="vdw-variable-toolbar"><code>sys.{variable.name}</code><span className="vdw-variable-type">{variable.type}{variable.nullable?' | null':''}</span>{variable.supported&&<Tooltip side="bottom" maxWidth={300} label={`复制 {{sys.${variable.name}}}`} portal><Button size="sm" className="vdw-icon-button" aria-label={`复制系统变量 ${variable.name}`} onClick={()=>void copy(`{{sys.${variable.name}}}`)}><Glyph name="copy"/></Button></Tooltip>}</header><div className="vdw-variable-panel-content"><p>{t(variable.description)}</p><code className="vdw-variable-current-value">{variable.supported?systemVariableValue(variable.name,flow,state.run,state.sessionId):t("暂不支持")}</code></div></section>)}</div>
      </>}
      {feedback&&<p role="status" className="vdw-muted">{t(feedback)}</p>}{error&&<p role="alert" className="vdw-error">{error}</p>}
    </div>
  </aside>
}

import { t, useLocale } from './i18n.ts'
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { NODE_LABELS, type JsonValue, type NodeConfig, type NodeKind, type WorkflowAPI } from '../shared/types.ts'
import { NODE_DEFINITIONS, definition } from './nodes.ts'
import { Field } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { CodeEditor } from './code-editor.tsx'

export interface ToolEntry { id:string; name:string; description:string; providerId:string; providerName:string; author?:string; category:'plugin'|'swagger'|'workflow'|'mcp'; inputSchema:Record<string,JsonValue>; available:boolean; unavailableReason?:string }
export interface ToolAPI { tools:(workspaceId:string,sessionId:string)=>Promise<ToolEntry[]>; importSwagger?:(workspaceId:string,definitionJson:string)=>Promise<ToolEntry[]> }
const TABS=[{id:'nodes',label:'节点'},{id:'tools',label:'工具'},{id:'start',label:'开始'},{id:'snippets',label:'Snippets'}]
const CATEGORIES=[{id:'all',label:'全部'},{id:'plugin',label:'工具插件'},{id:'swagger',label:'Swagger API'},{id:'workflow',label:'工作流'},{id:'mcp',label:'MCP'}]

export function NodePicker({onClose,onAdd,hasInput,inLoop,api,workspaceId,sessionId=''}:{onClose:()=>void;onAdd:(kind:NodeKind,config?:NodeConfig,title?:string)=>void;hasInput:boolean;inLoop:boolean;api:WorkflowAPI;workspaceId:string;sessionId?:string}) {useLocale();
  const [tab,setTab]=useState('nodes'),[search,setSearch]=useState(''),[agent,setAgent]=useState(false)
  const ref=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const close=(event:Event)=>{
      const target=event.target as Element
      if(ref.current&&!ref.current.contains(target)&&!target.closest(`[role=dialog],[role=menu],[role=listbox],[aria-label="${t('添加节点')}"]`))onClose()
    }
    const key=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||(event.target as Element).closest('[role=dialog],[role=menu],[role=listbox]'))return
      event.preventDefault();event.stopPropagation()
      const trigger=ref.current?.closest('.vdw')?.querySelector<HTMLButtonElement>(`[aria-label="${t('添加节点')}"]`)
      onClose();trigger?.focus()
    }
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',key)
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key)}
  },[onClose])
  const entries=NODE_DEFINITIONS.map(item=>({...item,description:t(item.description)})).filter(d=>d.kind!=='input'&&d.kind!=='tool'&&(d.kind!=='exit_loop'||inLoop)&&`${t(NODE_LABELS[d.kind])} ${t(NODE_LABELS[d.kind])} ${d.description}`.toLowerCase().includes(search.toLowerCase()))
  const changeTab=(id:string)=>{setTab(id);setSearch('')}
  return <section ref={ref} className="vdw-node-picker" aria-label={t("添加节点面板")} onPointerDown={e=>e.stopPropagation()}>
    <div className="vdw-picker-heading">
      <div className="vdw-picker-tabs" role="tablist" aria-label={t("节点目录")} onKeyDown={event=>{
        const index=TABS.findIndex(t=>t.id===tab)
        const next=event.key==='ArrowRight'?(index+1)%TABS.length:event.key==='ArrowLeft'?(index+TABS.length-1)%TABS.length:event.key==='Home'?0:event.key==='End'?TABS.length-1:-1
        if(next<0)return
        event.preventDefault();changeTab(TABS[next]!.id);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()
      }}>{TABS.map(item=><button type="button" role="tab" aria-selected={tab===item.id} tabIndex={tab===item.id?0:-1} key={item.id} onClick={()=>changeTab(item.id)}>{t(item.label)}</button>)}</div>
      <Tooltip label={t("关闭添加节点")} side="bottom" portal><Button size="sm" className="vdw-icon-button" aria-label={t("关闭添加节点")} onClick={onClose}><Glyph name="close"/></Button></Tooltip>
    </div>
    <div className="vdw-picker-search"><Input autoFocus aria-label={tab==='tools'?t("搜索工具"):t("搜索节点")} icon={<Glyph name="search"/>} placeholder={tab==='tools'?t("搜索集成、工具操作"):t("搜索节点")} value={search} onChange={e=>setSearch(e.target.value)}/></div>
    {tab==='nodes'&&<div className="vdw-picker-scroll">{[...new Set(entries.map(d=>d.group))].map(group=><section className="vdw-picker-group" key={group}>
      <h3>{t(group)}</h3>
      {entries.filter(d=>d.group===group).map(d=><div key={d.kind}>
        <Tooltip label={d.description} portal side="right" maxWidth={280} delayMs={240}>
          <button type="button" className="vdw-picker-row vdw-node-option" aria-expanded={d.kind==='agent'?agent:undefined} onClick={()=>d.kind==='agent'?setAgent(!agent):onAdd(d.kind)}>
            <NodeBadge kind={d.kind}/><span className="vdw-picker-label"><strong>{t(NODE_LABELS[d.kind])}</strong></span>
            {d.kind==='agent'&&<Glyph name={agent?'chevron-up':'chevron-down'}/>}
          </button>
        </Tooltip>
        {d.kind==='agent'&&agent&&<div className="vdw-agent-submenu"><Tooltip label={t("使用选定模型和授权工具，按步骤完成任务。")} portal side="right" maxWidth={280}>
          <button type="button" className="vdw-picker-row vdw-node-option vdw-agent-option" aria-label={t("添加工具调用 Agent")} onClick={()=>onAdd('agent')}><span className="vdw-picker-label"><strong>{t("工具调用 Agent")}</strong></span><span className="vdw-picker-add-action" aria-hidden="true"><Glyph name="plus" size={14}/><span>{t("添加")}</span></span></button>
        </Tooltip></div>}
      </div>)}
    </section>)}{!entries.length&&<div className="vdw-picker-empty"><p>{t("没有匹配的节点")}</p><Button size="sm" onClick={()=>setSearch('')}>{t("清除搜索")}</Button></div>}</div>}
    {tab==='tools'&&<ToolsPicker api={api as unknown as ToolAPI} workspaceId={workspaceId} sessionId={sessionId} search={search} onClearSearch={()=>setSearch('')} onSelect={tool=>onAdd('tool',{toolId:tool.id,inputs:toolDefaults(tool.inputSchema)},tool.name)}/>}
    {tab==='start'&&<div className="vdw-picker-scroll"><Tooltip label={t("手动执行时填写输入，或由对话提供参数。")} portal side="right" maxWidth={280}><button type="button" className="vdw-picker-row vdw-node-option" disabled={hasInput} onClick={()=>onAdd('input')}><NodeBadge kind="input"/><span className="vdw-picker-label"><strong>{t("用户输入")}</strong></span>{hasInput&&<small>{t("已添加")}</small>}</button></Tooltip><p className="vdw-picker-explainer">{t("每个流程只有一个用户输入起点。")}</p><div className="vdw-picker-unavailable"><strong>{t("定时触发器 · Webhook")}</strong><small>{t("当前运行引擎尚未接入触发订阅。可手动执行流程；触发器不能与用户输入起点混用。")}</small></div></div>}
    {tab==='snippets'&&<div className="vdw-picker-empty"><strong>{t("还没有代码片段")}</strong><p>{t("可在画布中复制现有节点组合。")}</p></div>}
  </section>
}

export function NodeBadge({kind}:{kind:NodeKind}) {
  const d=definition(kind)
  const icons:Record<string,string>={agent:'brain',llm:'brain',knowledge:'note',output:'exit',classifier:'branch',if:'branch',human:'person',iteration:'arrange',loop:'loop',code:'code',template:'note',aggregator:'merge',document:'note',assigner:'undo',extractor:'filter',http:'globe',list:'list',input:'play',tool:'tool',exit_loop:'exit'}
  return <span className={`vdw-node-badge tone-${d.color}`} aria-hidden="true"><Glyph name={icons[kind]||'arrange'} size={16}/></span>
}
export function toolDefaults(schema:Record<string,JsonValue>):Record<string,JsonValue> {
  const props=schema.properties
  if(!props||typeof props!=='object'||Array.isArray(props))return{}
  return Object.fromEntries(Object.entries(props).flatMap(([key,value])=>value&&typeof value==='object'&&!Array.isArray(value)&&value.default!==undefined?[[key,value.default]]:[]))
}

export function ToolsPicker({api,workspaceId,sessionId='',search,onSelect,onClearSearch}:{api:ToolAPI;workspaceId:string;sessionId?:string;search:string;onSelect:(tool:ToolEntry)=>void;onClearSearch?:()=>void}) {useLocale();
  const [tools,setTools]=useState<ToolEntry[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true)
  const [category,setCategory]=useState('all'),[sort,setSort]=useState('name'),[sortOpen,setSortOpen]=useState(false),[expanded,setExpanded]=useState<string[]>([])
  const [importing,setImporting]=useState<string>(),[pending,setPending]=useState(false)
  const refresh=async()=>{setLoading(true);setError('');try{if(!api.tools)throw new Error('工具目录连接暂不可用');setTools(await api.tools(workspaceId,sessionId))}catch(e){setError(String(e))}finally{setLoading(false)}}
  useEffect(()=>{void refresh()},[api,workspaceId,sessionId])
  const filtered=tools.filter(t=>(category==='all'||t.category===category)&&`${t.name} ${t.description} ${t.providerName}`.toLowerCase().includes(search.toLowerCase()))
  const groups=[...new Set(filtered.map(t=>t.providerId))].map(id=>({id,tools:filtered.filter(t=>t.providerId===id)})).sort((a,b)=>sort==='category'?a.tools[0]!.category.localeCompare(b.tools[0]!.category):a.tools[0]!.providerName.localeCompare(b.tools[0]!.providerName,'zh-CN'))
  return <>
    <div className="vdw-tool-filters"><div className="vdw-tool-category" role="tablist" aria-label={t("工具类别")} onKeyDown={event=>{
      const index=CATEGORIES.findIndex(t=>t.id===category)
      const next=event.key==='ArrowRight'?(index+1)%CATEGORIES.length:event.key==='ArrowLeft'?(index+CATEGORIES.length-1)%CATEGORIES.length:event.key==='Home'?0:event.key==='End'?CATEGORIES.length-1:-1
      if(next<0)return
      event.preventDefault();setCategory(CATEGORIES[next]!.id);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus()
    }}>{CATEGORIES.map(item=><button type="button" key={item.id} role="tab" aria-selected={category===item.id} tabIndex={category===item.id?0:-1} onClick={()=>setCategory(item.id)}>{t(item.label)}</button>)}</div></div>
    <div className="vdw-tool-list-heading"><span>{loading?t("正在读取工具…"):`${groups.length} 个集成 · ${filtered.length} 个操作`}</span>
      <Menu open={sortOpen} onClose={()=>setSortOpen(false)} portal align="end" listClassName="vdw-menu" selection="fill" selectedId={sort} items={[{id:'name',label:t('按名称排序')},{id:'category',label:t('按类别分组')}]} onSelect={id=>{setSort(id);setSortOpen(false)}} anchor={<Tooltip label={t("工具排序与分组")} side="bottom" portal><Button size="sm" className="vdw-icon-button" aria-label={t("工具排序与分组")} aria-haspopup="menu" aria-expanded={sortOpen} onClick={()=>setSortOpen(!sortOpen)}><Glyph name="sort"/></Button></Tooltip>}/>
    </div>
    <div className="vdw-picker-scroll">
      {loading?<p className="vdw-picker-empty" role="status">{t("正在读取可用工具…")}</p>:error?<div className="vdw-picker-empty"><p className="vdw-error" role="alert">{error}</p><Button size="sm" onClick={()=>void refresh()}>{t("重试")}</Button></div>:groups.map(g=>{
        const first=g.tools[0]!,open=expanded.includes(g.id)||!!search
        return <section key={g.id} className="vdw-tool-provider"><button type="button" className="vdw-picker-row vdw-provider-row" aria-expanded={open} onClick={()=>setExpanded(open?expanded.filter(id=>id!==g.id):[...expanded,g.id])}><NodeBadge kind="tool"/><span className="vdw-picker-label"><strong>{first.providerName}</strong><small>{first.author||t(CATEGORIES.find(c=>c.id===first.category)?.label||'')} · {g.tools.length} {t("个操作")}</small></span><Glyph name={open?'chevron-up':'chevron-down'}/></button>
          {open&&<div className="vdw-tool-operations">{g.tools.map(tool=><article key={tool.id} className={`vdw-tool-operation${tool.available?'':' is-unavailable'}`} aria-label={tool.name}>
            <Tooltip label={tool.unavailableReason||tool.description} portal side="right" maxWidth={280} delayMs={240}><button type="button" className="vdw-picker-row vdw-operation-row" aria-label={`添加工具：${tool.name}`} disabled={!tool.available} onClick={()=>{if(tool.available)onSelect(tool)}}><span className="vdw-picker-label"><strong>{tool.name}</strong><small>{tool.description}</small></span><span className="vdw-picker-add-action" aria-hidden="true">{tool.available?<><Glyph name="plus" size={14}/><span>{t("添加")}</span></>:<span>{t("不可用")}</span>}</span></button></Tooltip>
            {!tool.available&&<small className="vdw-error">{tool.unavailableReason||'此工具当前不可用'}</small>}
            <details className="vdw-tool-parameters"><summary>{t("参数说明")}</summary><SchemaDescription schema={tool.inputSchema}/></details>
          </article>)}</div>}
        </section>
      })}
      {!loading&&!error&&!filtered.length&&<div className="vdw-picker-empty"><p>{search?t("没有匹配的工具"):t("该类别尚无可用工具")}</p>{search&&onClearSearch&&<Button size="sm" onClick={onClearSearch}>{t("清除搜索")}</Button>}</div>}
    </div>
    <div className="vdw-picker-footer"><small>{t("已接入的真实工具")}</small><Button size="sm" disabled={loading} onClick={()=>void refresh()}>{t("刷新")}</Button>{api.importSwagger&&<Button size="sm" onClick={()=>setImporting('')}>{t("导入 OpenAPI")}</Button>}</div>
    {importing!==undefined&&<Modal open title={t("导入 OpenAPI / Swagger")} closeLabel={t("关闭导入")} className="vdw-modal" onClose={()=>!pending&&setImporting(undefined)} footer={<Button variant="primary" disabled={pending||!importing.trim()} onClick={async()=>{setPending(true);setError('');try{JSON.parse(importing);await api.importSwagger!(workspaceId,importing);setImporting(undefined);setCategory('swagger');await refresh()}catch(e){setError(String(e))}finally{setPending(false)}}}>{pending?t("导入中…"):t("导入")}</Button>}><Field label="OpenAPI JSON" help={t("粘贴 OpenAPI 3 或 Swagger 2 文档。操作将成为可配置的 API 工具。")}><CodeEditor label="OpenAPI JSON" language="json" rows={12} value={importing} disabled={pending} onChange={setImporting}/></Field>{error&&<p className="vdw-error" role="alert">{error}</p>}</Modal>}
  </>
}
export function SchemaDescription({schema}:{schema:Record<string,JsonValue>}) {
  const props=schema.properties,required=Array.isArray(schema.required)?schema.required:[]
  const fields=props&&typeof props==='object'&&!Array.isArray(props)?Object.entries(props):[]
  return <div className="vdw-tool-schema">{fields.length?fields.map(([name,s])=>{
    const field=s&&typeof s==='object'&&!Array.isArray(s)?s:{}
    return <div key={name}><div className="vdw-tool-schema-heading"><code>{name}</code><span>{String(field.type||'')}</span>{required.includes(name)&&<strong>{t("必填")}</strong>}</div>{!!field.description&&<p>{String(field.description)}</p>}</div>
  }):<small>{t("无需参数")}</small>}</div>
}

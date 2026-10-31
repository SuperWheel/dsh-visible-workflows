import { t, useLocale } from './i18n.ts'
import { useMemo, useState } from 'react'
import { Button, Input, Menu, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { HelpButton } from './controls.tsx'
import { Glyph } from './icons.tsx'
import type { ToolEntry } from './node-picker.tsx'

const FILTERS=[{id:'all',label:'全部工具'},{id:'selected',label:'已授权工具'},{id:'available',label:'可用工具'},{id:'plugin',label:'工具插件'},{id:'swagger',label:'Swagger API'},{id:'workflow',label:'工作流'},{id:'mcp',label:'MCP'}]

/** Search and filtering change only this view, never the node's tool authorization. */
export function ToolSelectionCard({tools,selected,error,loading=false,onChange,disabled}:{tools:readonly ToolEntry[];selected:readonly string[];error?:string;loading?:boolean;onChange:(ids:string[])=>void;disabled:boolean}){useLocale();
 const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[filterOpen,setFilterOpen]=useState(false)
 const selectedIds=useMemo(()=>new Set(selected),[selected]),query=search.trim().toLocaleLowerCase()
 const matches=(value:string)=>value.toLocaleLowerCase().includes(query)
 const visible=tools.filter(tool=>(filter==='all'||filter==='selected'&&selectedIds.has(tool.id)||filter==='available'&&tool.available||tool.category===filter)&&matches(`${tool.providerName} ${tool.name} ${tool.description} ${tool.id}`))
 const knownIds=new Set(tools.map(tool=>tool.id)),missing=!loading&&(filter==='all'||filter==='selected')?selected.filter(id=>!knownIds.has(id)&&matches(id)):[]
 const toggle=(id:string,checked:boolean)=>{if(disabled)return;onChange(checked?Array.from(new Set([...selected,id])):selected.filter(value=>value!==id))}
 return <section className="vdw-tool-selection" aria-label={t("可调用工具选择器")} aria-busy={loading}>
   <header className="vdw-tool-selection-heading"><strong>{t("可调用工具")}</strong><HelpButton label={t("可调用工具")} text={t("Agent 只能调用已授权的操作。")}/></header>
   <div className="vdw-tool-selection-toolbar">
    <Input aria-label={t("搜索可调用工具")} icon={<Glyph name="search"/>} placeholder={t("搜索工具或提供方")} value={search} onChange={event=>setSearch(event.target.value)}/>
    <Menu open={filterOpen} onClose={()=>setFilterOpen(false)} portal className="vdw-tool-selection-filter" listClassName="vdw-menu" selection="fill" selectedId={filter} items={FILTERS.map(item=>({...item,label:t(item.label)}))} onSelect={value=>{setFilter(value);setFilterOpen(false)}} anchor={<Tooltip side="bottom" maxWidth={300} label={`${t("筛选")}：${t(FILTERS.find(item=>item.id===filter)?.label||'')}`} portal><Button className="vdw-icon-button" size="sm" aria-label={t("筛选可调用工具")} aria-haspopup="menu" aria-expanded={filterOpen} aria-pressed={filter!=='all'} onClick={()=>setFilterOpen(!filterOpen)}><Glyph name="filter"/></Button></Tooltip>}/>
   </div>
   <div className="vdw-tool-selection-scroll" role="group" aria-label={t("工具授权列表")} tabIndex={0}>
    {visible.map(tool=><div className="vdw-tool-selection-row" key={tool.id}><span title={tool.description||`${tool.providerName} / ${tool.name}`}>{tool.providerName} / {tool.name}{!tool.available&&<small>{t("（不可用）")}</small>}</span><Switch checked={selectedIds.has(tool.id)} label={t('授权 {name}','Authorize {name}',{name:tool.name})} disabled={disabled||!tool.available&&!selectedIds.has(tool.id)} onChange={value=>toggle(tool.id,value)}/></div>)}
    {missing.map(id=><div className="vdw-tool-selection-row vdw-missing-tool" key={id}><span><strong>{id}</strong><small className="vdw-error">{t("工具未连接或子工作流不存在。可先移除，再选择可用工具。")}</small></span><Button size="sm" disabled={disabled} aria-label={t('移除缺失工具 {id}','Remove missing tool {id}',{id})} onClick={()=>toggle(id,false)}>{t("移除")}</Button></div>)}
    {!visible.length&&!missing.length&&<p className="vdw-tool-selection-empty">{loading?t("正在读取工具…"):search||filter!=='all'?t("没有符合条件的工具"):error?t("暂时无法读取工具"):t("没有可用工具")}</p>}
   </div>
   <div className="vdw-tool-selection-summary"><small>{t(FILTERS.find(item=>item.id===filter)?.label||'')} · {visible.length+missing.length} {t("项")}</small><small>{t('已授权 {count} 项','{count} authorized',{count:selected.length})}</small></div>
   {error&&<small className="vdw-error" role="alert">{error}</small>}
  </section>
}

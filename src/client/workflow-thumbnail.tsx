import { useMemo } from 'react'
import { useLocale } from './i18n.ts'
import type { NodeKind } from '../shared/types.ts'

export interface WorkflowThumbnailGraph { nodes:readonly {id:string;kind:NodeKind;x:number;y:number}[];edges:readonly {source:string;target:string}[] }
const colors:Partial<Record<NodeKind,string>>={input:'#4277ef',output:'#f59e0b',agent:'#8060b3',llm:'#8060b3',document:'#22c55e',template:'#4277ef',if:'#16a3a3',classifier:'#16a3a3',human:'#16a3a3',code:'#498eaa',tool:'#498eaa',http:'#498eaa',loop:'#e99731',iteration:'#e99731'}
/** A layout-only preview: no prompts, variable values, credentials, or imported HTML. */
export function WorkflowThumbnail({graph,label,emptyText}:{graph?:WorkflowThumbnailGraph;label?:string;emptyText?:string}){
  const {t}=useLocale()
  const layout=useMemo(()=>{
    if(!graph?.nodes.length)return undefined
    const nodes=graph.nodes.filter(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)),minX=Math.min(...nodes.map(node=>node.x))-48,minY=Math.min(...nodes.map(node=>node.y))-48
    if(!nodes.length)return undefined
    return {nodes,minX,minY,width:Math.max(352,Math.max(...nodes.map(node=>node.x+256))+48-minX),height:Math.max(176,Math.max(...nodes.map(node=>node.y+80))+48-minY)}
  },[graph])
  return <div className="vdw-workflow-thumbnail">{layout?<svg viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`} role="img" aria-label={label??t('流程缩略图','Workflow preview')} preserveAspectRatio="xMidYMid meet">
    {graph!.edges.map((edge,index)=>{const source=layout.nodes.find(node=>node.id===edge.source),target=layout.nodes.find(node=>node.id===edge.target);if(!source||!target)return null;return <path key={index} d={`M${source.x+256} ${source.y+40} C${source.x+296} ${source.y+40},${target.x-40} ${target.y+40},${target.x} ${target.y+40}`} fill="none" stroke="currentColor" strokeWidth="5" opacity=".45"/>})}
    {layout.nodes.map(node=><g key={node.id}><rect x={node.x} y={node.y} width="256" height="80" rx="12" fill="var(--dsw-alias-bg-base)" stroke="currentColor" strokeWidth="3" opacity=".8"/><rect x={node.x+16} y={node.y+22} width="36" height="36" rx="8" fill={colors[node.kind]??'#8a93a6'}/><rect x={node.x+66} y={node.y+27} width="152" height="10" rx="5" fill="currentColor" opacity=".35"/><rect x={node.x+66} y={node.y+46} width="108" height="8" rx="4" fill="currentColor" opacity=".18"/></g>)}
  </svg>:<span>{emptyText??t('暂无缩略图','No preview available')}</span>}</div>
}

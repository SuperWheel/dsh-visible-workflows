import { displayNodeNumber } from './annotation-nodes.ts'
import { t, useLocale } from './i18n.ts'
import { canvasOverviewStyles } from './canvas-overview-style.ts'
import { canvasChromeLayout } from './canvas-chrome.ts'
import { CanvasTopActions } from './canvas-top-actions.tsx'
import type { AdvancedSettingsTab } from './advanced-settings.tsx'
import { useEffect, useMemo, useRef, useState, type PointerEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { newId, type NodeKind, type Workflow, type WorkflowNode, type WorkflowAPI, type NodeConfig, type CanvasNote } from '../shared/types.ts'
import { Glyph } from './icons.tsx'
import { copyNodes } from './copy.ts'
import { arrangeNodes, fitView, overlaps, placeWithoutOverlap } from './layout.ts'
import { createViewportIndex, cullViewport, intersectsRect } from './viewport.ts'
import { MiniMap } from './mini-map.tsx'
import { useFrameState } from './use-frame-state.ts'
import { definition, isContainer, isModelNode, newNode, nodePorts, nodeSize, nodeSummary, portY } from './nodes.ts'
import { revealNode } from './inspector-viewport.ts'
import { noteSize, moveAttachedNotes, arrangeAttachedNotes } from './notes.ts'
import { StickyNote, stickyNoteStyles } from './sticky-note.tsx'
import { noteContentSvg, parseNoteContent, type NoteTextMeasure } from './note-content.ts'
import { NodeBadge, NodePicker } from './node-picker.tsx'
import { NodeBranches } from './node-branches.tsx'
import type { AnnotationPosition } from './annotation-position.ts'
import type { WorkflowReadinessIssue } from '../shared/workflow-import.ts'
import { NodeReadinessWarning } from './workflow-readiness.tsx'

export interface CanvasAnnotation { id:string; number:number; nodeIds:string[]; text:string; position?:AnnotationPosition }
export interface AnnotationPlacement { position:AnnotationPosition; anchorRect:Pick<DOMRect,'left'|'right'|'top'|'bottom'> }
interface Props {
  workflow:Workflow; variablePanel?:'environment'|'system'; onEnvironment?:()=>void; onSystem?:()=>void; onPolicy?:()=>void; onJson?:(intent:'import'|'export')=>void; onTemplates?:()=>void; inspectorOpen?:boolean; inspectorNodeId?:string; executionActions?:ReactNode; onAgent?:()=>void; nested?:boolean; api:WorkflowAPI; sessionId?:string; inLoop?:boolean; onEnter:(id:string)=>void; selected:string[]; disabled:boolean; canUndo:boolean; canRedo:boolean
  advancedSettings?:ReactNode; advancedTab?:AdvancedSettingsTab; onAdvanced?:()=>void; onCloseAdvanced?:()=>void
  libraryPanel?:ReactNode; libraryOpen?:boolean; onCloseLibrary?:()=>void; onCreateTemplate?:()=>void
  onSelect:(ids:string[])=>void; onEdit:(flow:Workflow)=>void; onConfigure:(id:string)=>void
  onAnnotate:(placement:AnnotationPlacement)=>void; onEditAnnotation:(id:string,rect?:Pick<DOMRect,'left'|'right'|'top'|'bottom'>)=>void; annotations:CanvasAnnotation[]
  scopePath?:string[]; pendingAnnotation?:CanvasAnnotation
  readinessIssues?:WorkflowReadinessIssue[]
  onUndo:()=>void;onRedo:()=>void;onNote?:()=>void;onRunDetails:()=>void
  registerViewport?:(read:()=>{x:number;y:number;scale:number},workflowId:string)=>()=>void
  viewport:{x:number;y:number;scale:number};onViewport:(view:{x:number;y:number;scale:number})=>void
}
type Drag={kind:'pan'|'box'|'nodes'|'note'|'resize';note?:CanvasNote;startX:number;startY:number;x:number;y:number;nodes:WorkflowNode[];ids:string[];moved:boolean}
const escapeXML=(v:string)=>v.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]!))
export function svgForWorkflow(flow:Workflow,colors={bg:'#ffffff',fg:'#242424'}):string {
  const {bg,fg}=colors
  let fontFamily='sans-serif',measure:NoteTextMeasure|undefined
  if(typeof document!=='undefined'){
    fontFamily=getComputedStyle(document.body).getPropertyValue('--dsw-font-family').trim()||fontFamily
    const context=document.createElement('canvas').getContext('2d')
    if(context)measure=(text,style)=>{context.font=`${style.weight} ${style.fontSize}px ${style.code?'monospace':fontFamily}`;return context.measureText(text).width}
  }
  const notes=flow.notes.map(note=>({note,size:noteSize(note),blocks:parseNoteContent(note.text)}))
  const minX=Math.min(0,...flow.nodes.map(n=>n.x-40),...flow.notes.map(n=>n.x-40)),minY=Math.min(0,...flow.nodes.map(n=>n.y-40),...flow.notes.map(n=>n.y-40))
  const width=Math.max(800,...flow.nodes.map(n=>n.x+nodeSize(n).width+60),...notes.map(({note,size})=>note.x+size.width+60))-minX,height=Math.max(400,...flow.nodes.map(n=>n.y+nodeSize(n).height+60),...notes.map(({note,size})=>note.y+size.height+60))-minY
  const noteLinks=flow.notes.map(note=>{const node=flow.nodes.find(n=>n.id===note.anchorNodeId);if(!node)return '';const a=noteSize(note),b=nodeSize(node);return `<line x1="${note.x+a.width/2}" y1="${note.y+a.height/2}" x2="${node.x+b.width/2}" y2="${node.y+b.height/2}" stroke="${escapeXML(fg)}" stroke-opacity=".35" stroke-dasharray="5 5"/>`}).join('')
  const lines=flow.edges.map(e=>{const a=flow.nodes.find(n=>n.id===e.source),b=flow.nodes.find(n=>n.id===e.target);if(!a||!b)return '';const x=a.x+nodeSize(a).width,y=a.y+portY(a,e.port||'default'),ty=b.y+nodeSize(b).height/2;return `<path d="M${x} ${y} C${x+50} ${y},${b.x-50} ${ty},${b.x} ${ty}" fill="none" stroke="${escapeXML(fg)}" opacity=".35"/>`}).join('')
  const sticky=notes.map(({note,size,blocks},i)=>{
    const paper=({yellow:'#ffe975',blue:'#8fd0ff',purple:'#b9a0ff',green:'#a3d9b0',neutral:'#b6bbc7'}[note.color||'yellow'])||'#ffe975'
    return `<g transform="translate(${note.x},${note.y})"><rect width="${size.width}" height="${size.height}" rx="8" fill="color-mix(in srgb, ${paper} 14%, ${escapeXML(bg)})" stroke="${escapeXML(fg)}" stroke-opacity=".15"/><path d="M8 0H${size.width-8}Q${size.width} 0 ${size.width} 6H0Q0 0 8 0Z" fill="color-mix(in srgb, ${paper} 23%, ${escapeXML(bg)})"/><clipPath id="note-clip-${i}"><rect x="16" y="22" width="${size.width-32}" height="${size.height-38}"/></clipPath><g clip-path="url(#note-clip-${i})">${noteContentSvg(blocks,size.width,fg,measure)}</g></g>`
  }).join('')
  const nodes=flow.nodes.map((n,i)=>{const size=nodeSize(n),ports=nodePorts(n);return `<g transform="translate(${n.x},${n.y})"><rect width="${size.width}" height="${size.height}" rx="12" fill="${escapeXML(bg)}" stroke="${escapeXML(fg)}" stroke-opacity=".3" ${isContainer(n.kind)?'stroke-dasharray="6 4"':''}/><clipPath id="clip-${i}"><rect x="14" y="8" width="${size.width-28}" height="${size.height-16}"/></clipPath><g clip-path="url(#clip-${i})"><text x="16" y="29" fill="${escapeXML(fg)}" font-size="14" font-weight="600">${escapeXML(displayNodeNumber(n.number))} · ${escapeXML(n.title)}${n.fixed?t(' · 固定',' · Pinned'):''}</text>${isModelNode(n.kind)?`<text x="16" y="57" fill="${escapeXML(fg)}" font-size="11">${escapeXML(n.config.model?.model||t('跟随 DSH','Follow DSH'))}</text>`:''}<text x="16" y="${isModelNode(n.kind)?83:57}" fill="${escapeXML(fg)}" opacity=".6" font-size="11">${escapeXML(nodeSummary(n).replace(/\n/g,' '))}</text>${ports.length>1?ports.map(p=>`<text x="${size.width-16}" y="${portY(n,p.id)+4}" text-anchor="end" fill="${escapeXML(fg)}" font-size="11">${escapeXML(p.label)}</text>`).join(''):''}${isContainer(n.kind)?`<path d="M14 80H${size.width-14}" stroke="${escapeXML(fg)}" opacity=".2" stroke-dasharray="4 4"/>${(n.config.body?.nodes||[]).slice(0,5).map((child,j)=>`<text x="24" y="${104+j*22}" fill="${escapeXML(fg)}" font-size="12">${escapeXML(displayNodeNumber(child.number))} · ${escapeXML(child.title)}</text>`).join('')}`:''}</g></g>`}).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="${escapeXML(fontFamily)}"><title>${escapeXML(flow.title)}</title><rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${escapeXML(bg)}"/>${lines}${noteLinks}${sticky}${nodes}</svg>`
}
function exportSvg(flow:Workflow){
  const root=getComputedStyle(document.body),bg=root.getPropertyValue('--dsw-alias-bg-base').trim()||'#fff',fg=root.getPropertyValue('--dsw-alias-label-primary').trim()||'#222'
  const blob=new Blob([svgForWorkflow(flow,{bg,fg})],{type:'image/svg+xml'})
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${flow.title}.svg`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}

export function Canvas(p:Props){
  const {t,locale}=useLocale()
  const [view,setView,viewRef]=useFrameState(p.viewport),[mode,setMode]=useState<'pointer'|'hand'>('pointer')
  const [selectedNote,setSelectedNote]=useState(''),[editingNote,setEditingNote]=useState(''),[notePreview,setNotePreview]=useState<CanvasNote[]>(),[inspector,setInspector]=useState({width:0,top:60})
  const [topMode,setTopMode]=useState<'full'|'icons'|'overflow'>('full')
  const nudging=useRef(false),notePreviewRef=useRef<CanvasNote[]>(),topActions=useRef<HTMLDivElement>(null),animation=useRef<number>()
  const [preview,setPreview]=useState<WorkflowNode[]>(),[box,setBox]=useState<{x:number;y:number;w:number;h:number}>(),[size,setSize]=useState({width:0,height:0}),[minimap,setMinimap]=useState<boolean>()
  const previewRef=useRef<WorkflowNode[]>(),boxRef=useRef<typeof box>(),surfaceRect=useRef<DOMRect>(),moveFrame=useRef<number>(),pendingMove=useRef<()=>void>()
  const [palette,setPalette]=useState(false),[context,setContext]=useState<{x:number;y:number}>(),[link,setLink]=useState<{id:string;port:string}>()
  const [selectedEdge,setSelectedEdge]=useState(''),[message,setMessage]=useState(''),[focusedNode,setFocusedNode]=useState<string>(),[placingAnnotation,setPlacingAnnotation]=useState(false)
  const surface=useRef<HTMLDivElement>(null),drag=useRef<Drag>()
  useEffect(()=>{if(p.advancedTab)setPalette(false)},[p.advancedTab])
  useEffect(()=>{if(p.libraryOpen)setPalette(false)},[p.libraryOpen])
  useEffect(()=>p.registerViewport?.(()=>viewRef.current,p.workflow.id),[p.registerViewport,p.workflow.id])
  const notifyViewport=useRef(p.onViewport);notifyViewport.current=p.onViewport
  useEffect(()=>{const timer=setTimeout(()=>notifyViewport.current(view),100);return()=>clearTimeout(timer)},[view])
  useEffect(()=>{const element=surface.current;if(!element)return;const observer=new ResizeObserver(()=>{surfaceRect.current=element.getBoundingClientRect();setSize({width:element.clientWidth,height:element.clientHeight})});observer.observe(element);return()=>observer.disconnect()},[])
  useEffect(()=>()=>{if(moveFrame.current!==undefined)cancelAnimationFrame(moveFrame.current)},[])
  useEffect(()=>{const element=surface.current;if(!element)return;const prevent=(e:WheelEvent)=>e.preventDefault();element.addEventListener('wheel',prevent,{passive:false});return()=>element.removeEventListener('wheel',prevent)},[])
  function stopAnimation(){if(animation.current!==undefined){cancelAnimationFrame(animation.current);animation.current=undefined}}
  function animateView(target:typeof view){
    stopAnimation()
    if(typeof window==='undefined'||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){setView(target);return}
    const start=viewRef.current;let began:number|undefined
    const frame=(time:number)=>{began??=time;const t=Math.min(1,(time-began)/260),ease=1-(1-t)**3;setView({...target,x:start.x+(target.x-start.x)*ease,y:start.y+(target.y-start.y)*ease});if(t<1)animation.current=requestAnimationFrame(frame);else animation.current=undefined}
    animation.current=requestAnimationFrame(frame)
  }
  useEffect(()=>()=>stopAnimation(),[])
  useEffect(()=>{
    const parent=surface.current?.closest?.('.vdw-editor-body') as HTMLElement|undefined;if(!parent)return
    const panel=parent.querySelector<HTMLElement>('.vdw-editor-dock,.vdw-config,.vdw-run-panel,.vdw-variable-panel'),heading=parent.querySelector<HTMLElement>('.vdw-editor-heading'),actions=topActions.current
    const measure=()=>{
      const selection=actions?.querySelector<HTMLElement>('.vdw-selection-actions'),execution=actions?.querySelector<HTMLElement>('.vdw-execution-actions')
      const controlHeight=parseFloat(getComputedStyle(parent).getPropertyValue('--vdw-control-height'))||32
      // Labels keep their natural size when hidden. Decisions never use the current mode's button width.
      const fullButtonWidth=(button:Element|null|undefined)=>{if(!button)return 0;const label=button.querySelector('.vdw-control-label');if(!label)return button.getBoundingClientRect().width;const icon=button.querySelector('svg')?.getBoundingClientRect().width||0;return label.getBoundingClientRect().width+icon+(icon?4:0)+16}
      const agent=actions?.querySelector('.vdw-agent-action'),policy=actions?.querySelector('.vdw-policy-action'),primary=Array.from(actions?.querySelectorAll('.vdw-primary-execution button')||[]),agentWidth=fullButtonWidth(agent),primaryWidth=primary.reduce((sum,button)=>sum+fullButtonWidth(button),0)+Math.max(0,primary.length-1)*2,menuWidth=actions?.querySelector('.vdw-canvas-overflow')?.getBoundingClientRect().width||0,variableWidth=actions?.querySelector('.vdw-variable-actions')?.getBoundingClientRect().width||0,policyWidth=policy?controlHeight:0
      const dimensions=(element:Element|undefined)=>{const css=element?getComputedStyle(element):undefined,num=(name:string)=>parseFloat(css?.getPropertyValue(name)||'')||0;return{frame:num('padding-left')+num('padding-right')+num('border-left-width')+num('border-right-width'),gap:num('column-gap')}}
      const {frame,gap}=dimensions(execution||undefined),selectionDimensions=dimensions(selection||undefined),selectionButtons=selection?Array.from(selection.querySelectorAll('button')):[],countWidth=selection?.querySelector('.vdw-selection-count')?.getBoundingClientRect().width||0
      const fullExecution=execution?frame+primaryWidth+agentWidth+policyWidth+Math.max(0,Number(!!primaryWidth)+Number(!!agentWidth)+Number(!!policyWidth)-1)*gap:0,selectionWidth=selection?selectionDimensions.frame+countWidth+selectionButtons.reduce((sum,button)=>sum+fullButtonWidth(button),0)+selectionDimensions.gap*selectionButtons.length:0
      const iconSelection=selection?selectionDimensions.frame+selectionButtons.length*controlHeight+Math.max(0,selectionButtons.length-1)*selectionDimensions.gap:0,iconExecution=execution?frame+(agent?controlHeight:0)+policyWidth+primary.length*controlHeight+Math.max(0,primary.length-1)*2+Math.max(0,Number(!!agent)+Number(!!policy)+Number(!!primary.length)-1)*gap:0
      // Reserve readable title space in addition to the measured save/navigation buttons.
      const headingButtons=Array.from(heading?.querySelectorAll('.vdw-editor-back,.vdw-editor-save-actions,.vdw-editor-conversation')||[]),headingGap=dimensions(heading?.querySelector('.vdw-editor-heading-row')||undefined).gap
      const headingMinWidth=112+headingButtons.reduce((sum,button)=>sum+button.getBoundingClientRect().width,0)+headingButtons.length*headingGap
      const layout=canvasChromeLayout(parent.clientWidth,heading?{left:heading.offsetLeft,top:heading.offsetTop,width:heading.offsetWidth,height:heading.offsetHeight,minWidth:headingMinWidth}:undefined,{fullWidth:selectionWidth+fullExecution+(selectionWidth&&fullExecution?8:0)+variableWidth+(variableWidth?8:0),iconWidth:iconSelection+iconExecution+(iconSelection&&iconExecution?8:0)+variableWidth+(variableWidth?8:0),compactWidth:frame+primaryWidth+menuWidth+(primaryWidth&&menuWidth?gap:0)+variableWidth+(variableWidth?8:0),height:Math.max(selection?.offsetHeight||0,execution?.offsetHeight||0)})
      const top=layout.inspectorTop,width=p.inspectorOpen?(panel?.getBoundingClientRect().width||Math.min(360,Math.max(0,parent.clientWidth-24)))+12:0
      parent.style.setProperty('--vdw-heading-max-width',`${layout.headingMaxWidth}px`);parent.style.setProperty('--vdw-actions-top',`${layout.actionsTop}px`);parent.style.setProperty('--vdw-inspector-top',`${top}px`);parent.style.setProperty('--vdw-inspector-width',`${width}px`)
      setTopMode(layout.mode)
      setInspector(current=>current.width===width&&current.top===top?current:{width,top})
    }
    measure();const observer=new ResizeObserver(measure);observer.observe(parent);if(panel)observer.observe(panel);if(heading)observer.observe(heading);if(actions){observer.observe(actions);actions.querySelectorAll('.vdw-selection-actions,.vdw-selection-count,.vdw-execution-actions,.vdw-agent-action,.vdw-primary-execution,.vdw-control-label,.vdw-canvas-overflow,.vdw-variable-actions,.vdw-policy-action').forEach(child=>observer.observe(child))}return()=>observer.disconnect()
  },[p.inspectorOpen,p.inspectorNodeId,p.selected.length,p.disabled,locale])
  useEffect(()=>{
    if(!p.inspectorOpen){stopAnimation();return}
    if(!p.inspectorNodeId||!inspector.width||!size.width||drag.current)return
    const node=p.workflow.nodes.find(n=>n.id===p.inspectorNodeId);if(!node)return
    const target=revealNode(node,viewRef.current,size.width,size.height,inspector.width,inspector.top);if(target)animateView(target)
  },[p.inspectorOpen,p.inspectorNodeId,inspector.width,inspector.top,size.width,size.height])
  const inspectorWidth=p.inspectorOpen?inspector.width:0
  const availableWidth=Math.max(80,size.width-inspectorWidth),compact=!!p.inspectorOpen&&availableWidth<280
  const nodes=preview||p.workflow.nodes
  const notes=notePreview|| (preview?moveAttachedNotes(p.workflow.notes,p.workflow.nodes,preview):p.workflow.notes)
  const viewportIndex=useMemo(()=>createViewportIndex(nodes,p.workflow.edges),[nodes,p.workflow.edges])
  const focusKeep=useMemo(()=>focusedNode?new Set([focusedNode]):undefined,[focusedNode])
  const visible=useMemo(()=>cullViewport(viewportIndex,view,size.width,size.height,200,focusKeep),[viewportIndex,view,size,focusKeep])
  const selectedSet=useMemo(()=>new Set(p.selected),[p.selected])
  const annotationMarkers=[...p.annotations.filter(note=>note.id!==p.pendingAnnotation?.id),...(p.pendingAnnotation?[p.pendingAnnotation]:[])].flatMap(note=>{
    if(note.position){if(note.position.scopePath.length!==(p.scopePath?.length||0)||note.position.scopePath.some((id,i)=>id!==p.scopePath?.[i]))return [];return [{...note,point:note.position}]}
    // Older drafts have no click position; preserve a single, usable marker.
    const node=nodes.find(node=>note.nodeIds.includes(node.id));return node?[{...note,point:{x:node.x+nodeSize(node).width,y:node.y}}]:[]
  })
  useEffect(()=>{if(!p.selected.length)setPlacingAnnotation(false)},[p.selected.length])
  useEffect(()=>{if(size.width>0)setMinimap(current=>current??size.width>=480)},[size.width])
  const showMinimap=minimap??false
  // A compact inspector covers the top of the canvas. Project and navigate the
  // exposed strip beside the minimap instead of the hidden 80px left sliver.
  const overviewTop=compact?Math.max(0,size.height-(size.width<360?242:198)+12):0
  const overviewView=compact?{...view,y:view.y-overviewTop}:view
  const overviewWidth=compact?Math.max(80,size.width-186):availableWidth,overviewHeight=compact?126:size.height
  const visibleNotes=useMemo(()=>notes.filter(note=>note.id===editingNote||intersectsRect({...note,...noteSize(note)},visible.world)),[notes,editingNote,visible.world])
  function toPoint(x:number,y:number){const rect=surfaceRect.current||surface.current!.getBoundingClientRect(),current=viewRef.current;return{x:(x-rect.left-current.x)/current.scale,y:(y-rect.top-current.y)/current.scale}}
  function placeAnnotation(clientX:number,clientY:number){
    surfaceRect.current=surface.current!.getBoundingClientRect();setPlacingAnnotation(false);setContext(undefined);stopAnimation()
    p.onAnnotate({position:{...toPoint(clientX,clientY),scopePath:[...(p.scopePath||[])]},anchorRect:{left:clientX-14,right:clientX+14,top:clientY-14,bottom:clientY+14}})
  }
  function finishNudge(){
    if(!nudging.current)return;nudging.current=false
    const nextNodes=previewRef.current||p.workflow.nodes,nextNotes=notePreviewRef.current||moveAttachedNotes(p.workflow.notes,p.workflow.nodes,nextNodes)
    p.onEdit({...p.workflow,nodes:nextNodes,notes:nextNotes});previewRef.current=undefined;notePreviewRef.current=undefined;setPreview(undefined);setNotePreview(undefined)
  }
  function nudge(e:KeyboardEvent<HTMLDivElement>){
    if(p.disabled||(!selectedNote&&!p.selected.length))return
    e.preventDefault();stopAnimation();nudging.current=true
    const amount=e.shiftKey?10:1,dx=e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0,dy=e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0
    if(selectedNote){notePreviewRef.current=(notePreviewRef.current||p.workflow.notes).map(n=>n.id===selectedNote?{...n,x:n.x+dx,y:n.y+dy}:n);setNotePreview(notePreviewRef.current)}
    else {const ids=new Set(p.selected);previewRef.current=(previewRef.current||p.workflow.nodes).map(n=>ids.has(n.id)?{...n,x:Math.max(0,n.x+dx),y:Math.max(0,n.y+dy)}:n);setPreview(previewRef.current)}
  }
  function begin(e:PointerEvent<HTMLDivElement>,node?:WorkflowNode){
    if(e.button!==0||((e.target as Element).closest('button')))return
    finishNudge();stopAnimation();setSelectedNote('')
    if(node)e.stopPropagation()
    surfaceRect.current=surface.current!.getBoundingClientRect()
    setContext(undefined);setSelectedEdge('')
    const ids=node?(e.shiftKey?(p.selected.includes(node.id)?p.selected.filter(id=>id!==node.id):[...p.selected,node.id]):p.selected.includes(node.id)?p.selected:[node.id]):e.shiftKey?p.selected:[]
    if(node&&mode==='pointer'){p.onSelect(ids);if(e.shiftKey)return}else if(mode==='pointer')p.onSelect(ids)
    surface.current!.setPointerCapture(e.pointerId)
    drag.current={kind:mode==='hand'?'pan':node?'nodes':'box',startX:e.clientX,startY:e.clientY,x:viewRef.current.x,y:viewRef.current.y,nodes,ids,moved:false}
  }
  function beginNote(e:PointerEvent<HTMLElement>,note:CanvasNote,resize=false){
    if(e.button!==0||p.disabled)return;e.preventDefault();e.stopPropagation();stopAnimation();setSelectedNote(note.id);p.onSelect([]);setSelectedEdge('');setEditingNote('');surfaceRect.current=surface.current!.getBoundingClientRect();surface.current!.setPointerCapture(e.pointerId)
    drag.current={kind:resize?'resize':'note',note,startX:e.clientX,startY:e.clientY,x:viewRef.current.x,y:viewRef.current.y,nodes,ids:[],moved:false}
  }
  function updateNote(note:CanvasNote){p.onEdit({...p.workflow,notes:p.workflow.notes.map(n=>n.id===note.id?note:n)})}
  function deleteNote(id:string){p.onEdit({...p.workflow,notes:p.workflow.notes.filter(n=>n.id!==id)});setSelectedNote('');setEditingNote('')}
  function addNote(){
    surfaceRect.current=surface.current?.getBoundingClientRect();const rect=surfaceRect.current,point=rect?toPoint(rect.left+availableWidth/2,rect.top+size.height/2):{x:180,y:120}
    const obstacles=[...nodes.map(n=>({...n,...nodeSize(n)})),...notes.map(n=>({...n,...noteSize(n)}))];let position={x:point.x-140,y:point.y-90,width:280,height:180};for(let i=0;i<20&&obstacles.some(r=>overlaps(position,r,24));i++)position={...position,y:point.y-90+(i%2===0?-1:1)*(Math.floor(i/2)+1)*212};const note:CanvasNote={id:newId(),text:'',...position,color:'yellow'};p.onEdit({...p.workflow,notes:[...p.workflow.notes,note]});p.onSelect([]);setSelectedNote(note.id);setEditingNote(note.id);animateView({...viewRef.current,x:Math.max(80,availableWidth)/2-(note.x+140)*viewRef.current.scale,y:size.height/2-(note.y+90)*viewRef.current.scale})
  }
  function move(e:PointerEvent<HTMLDivElement>){
    const clientX=e.clientX,clientY=e.clientY,currentDrag=drag.current
    if(currentDrag?.kind==='pan'){const dx=clientX-currentDrag.startX,dy=clientY-currentDrag.startY;if(Math.abs(dx)+Math.abs(dy)>4)currentDrag.moved=true;setView({...viewRef.current,x:currentDrag.x+dx,y:currentDrag.y+dy});return}
    pendingMove.current=()=>{
      const d=drag.current;if(!d)return
      const dx=clientX-d.startX,dy=clientY-d.startY;if(Math.abs(dx)+Math.abs(dy)>4)d.moved=true
      if(d.kind==='nodes'&&!p.disabled){const scale=viewRef.current.scale,ids=new Set(d.ids);previewRef.current=d.nodes.map(n=>ids.has(n.id)?{...n,x:Math.max(0,n.x+dx/scale),y:Math.max(0,n.y+dy/scale)}:n);setPreview(previewRef.current)}
      if((d.kind==='note'||d.kind==='resize')&&d.note&&!p.disabled){const scale=viewRef.current.scale,size=noteSize(d.note),next=d.kind==='note'?{...d.note,x:d.note.x+dx/scale,y:d.note.y+dy/scale}:{...d.note,width:Math.max(160,Math.min(1200,size.width+dx/scale)),height:Math.max(100,Math.min(900,size.height+dy/scale))};notePreviewRef.current=p.workflow.notes.map(n=>n.id===next.id?next:n);setNotePreview(notePreviewRef.current)}
      if(d.kind==='box'){const a=toPoint(d.startX,d.startY),b=toPoint(clientX,clientY);boxRef.current={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)};setBox(boxRef.current)}
    }
    if(moveFrame.current!==undefined)return
    moveFrame.current=requestAnimationFrame(()=>{moveFrame.current=undefined;pendingMove.current?.();pendingMove.current=undefined})
  }
  function end(e:PointerEvent<HTMLDivElement>){
    // Pointer-up can carry a newer position than the final coalesced move.
    if(drag.current)move(e)
    if(moveFrame.current!==undefined){cancelAnimationFrame(moveFrame.current);moveFrame.current=undefined}pendingMove.current?.();pendingMove.current=undefined
    const d=drag.current;if(!d)return;drag.current=undefined
    const finalPreview=previewRef.current,finalBox=boxRef.current
    if(d.kind==='nodes'&&d.moved&&finalPreview&&!p.disabled)p.onEdit({...p.workflow,nodes:finalPreview,notes:moveAttachedNotes(p.workflow.notes,p.workflow.nodes,finalPreview)})
    if(d.kind==='nodes'&&!d.moved&&d.ids.length===1)p.onConfigure(d.ids[0]!)
    if((d.kind==='note'||d.kind==='resize')&&d.moved&&notePreviewRef.current&&!p.disabled)p.onEdit({...p.workflow,notes:notePreviewRef.current})
    setNotePreview(undefined);notePreviewRef.current=undefined
    if(d.kind==='box'&&finalBox)p.onSelect([...new Set([...d.ids,...nodes.filter(n=>n.x<finalBox.x+finalBox.w&&n.x+nodeSize(n).width>finalBox.x&&n.y<finalBox.y+finalBox.h&&n.y+nodeSize(n).height>finalBox.y).map(n=>n.id)])])
    setBox(undefined);setPreview(undefined);boxRef.current=undefined;previewRef.current=undefined
    if(surface.current?.hasPointerCapture(e.pointerId))surface.current.releasePointerCapture(e.pointerId)
  }
  function add(kind:NodeKind,config?:NodeConfig,title?:string){
    setPalette(false);const center=surface.current?.getBoundingClientRect();surfaceRect.current=center;const point=center?toPoint(center.x+center.width/2,center.y+center.height/2):{x:250,y:180}
    const draft=newNode(kind,0,0,config),size=nodeSize(draft)
    const node=placeWithoutOverlap([draft],p.workflow.nodes,{x:point.x-size.width/2,y:point.y-size.height/2})[0]!
    if(title)node.title=title
    p.onEdit({...p.workflow,nodes:[...p.workflow.nodes,node]});p.onSelect([node.id]);p.onConfigure(node.id)
  }
  function remove(){
    if(p.disabled)return
    if(selectedNote){deleteNote(selectedNote);return}
    if(selectedEdge){p.onEdit({...p.workflow,edges:p.workflow.edges.filter(e=>e.id!==selectedEdge)});setSelectedEdge('');return}
    const remaining=p.workflow.nodes.filter(n=>!p.selected.includes(n.id))
    p.onEdit({...p.workflow,nodes:remaining,notes:moveAttachedNotes(p.workflow.notes,p.workflow.nodes,remaining),edges:p.workflow.edges.filter(e=>!p.selected.includes(e.source)&&!p.selected.includes(e.target))});p.onSelect([])
  }
  function duplicate(){
    const copied=copyNodes({nodes:p.workflow.nodes.filter(n=>p.selected.includes(n.id)),edges:p.workflow.edges.filter(e=>p.selected.includes(e.source)&&p.selected.includes(e.target))})
    const origin={x:Math.min(...copied.nodes.map(n=>n.x))+48,y:Math.min(...copied.nodes.map(n=>n.y))+48}
    const extra=placeWithoutOverlap(copied.nodes,p.workflow.nodes,origin)
    p.onEdit({...p.workflow,nodes:[...p.workflow.nodes,...extra],edges:[...p.workflow.edges,...copied.edges]});p.onSelect(extra.map(n=>n.id))
  }
  function fit(target=nodes,notesToFit=p.workflow.notes){stopAnimation();const rect=surface.current?.getBoundingClientRect();if(rect)setView(fitView(target,Math.max(80,rect.width-inspectorWidth),rect.height,notesToFit.map(note=>({...note,...noteSize(note)}))))}
  function arrange(){const arranged=arrangeNodes(p.workflow),notes=arrangeAttachedNotes(p.workflow.notes,arranged);p.onEdit({...p.workflow,nodes:arranged,notes});fit(arranged,notes)}
  const actions=[{id:'note',label:t('添加注释','Add annotation'),icon:<Glyph name="comment"/>},{id:'fixed',label:p.workflow.nodes.filter(n=>p.selected.includes(n.id)).every(n=>n.fixed)?t('取消固定','Unpin nodes'):t('固定节点','Pin nodes'),disabled:p.disabled,icon:<Glyph name="lock"/>},{id:'about',label:t('关于此节点','About this node'),icon:<Glyph name="info"/>},{id:'copy',label:t('复制节点','Duplicate nodes'),disabled:p.disabled,icon:<Glyph name="copy"/>},...(p.onCreateTemplate?[{id:'template',label:t('创建模板','Create template'),disabled:p.disabled||!p.selected.length,icon:<Glyph name="arrange"/>}]:[]),{id:'delete',label:t('删除节点','Delete nodes'),disabled:p.disabled,danger:true,icon:<Glyph name="trash"/>}]
  return <div className={`vdw-canvas-wrap ${p.inspectorOpen?'is-inspecting':''} ${compact?'is-inspector-compact':''} ${size.width<360?'is-overview-tiny':''}`} data-total-nodes={nodes.length} data-rendered-nodes={visible.nodes.length} data-rendered-edges={visible.edges.length}>
    <style>{stickyNoteStyles+canvasOverviewStyles}</style>
    <div ref={surface} onPointerDownCapture={e=>{if(placingAnnotation&&e.button===0){e.preventDefault();e.stopPropagation();placeAnnotation(e.clientX,e.clientY)}}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))finishNudge()}} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))finishNudge()}} className={`vdw-canvas ${mode==='hand'?'is-hand':''} ${placingAnnotation?'is-placing-annotation':''}`} tabIndex={0} aria-label={t('工作流画布','Workflow canvas')} style={{backgroundSize:`${24*view.scale}px ${24*view.scale}px`,backgroundPosition:`${view.x}px ${view.y}px`}} onPointerDown={e=>begin(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{setNotePreview(undefined);notePreviewRef.current=undefined;drag.current=undefined;boxRef.current=undefined;previewRef.current=undefined;pendingMove.current=undefined;setBox(undefined);setPreview(undefined)}} onWheel={e=>{stopAnimation();surfaceRect.current=surface.current!.getBoundingClientRect();const view=viewRef.current;if(e.ctrlKey||e.metaKey){const s=Math.max(.2,Math.min(2,view.scale*(e.deltaY>0?.92:1.08)));const point=toPoint(e.clientX,e.clientY);setView({x:view.x+point.x*(view.scale-s),y:view.y+point.y*(view.scale-s),scale:s})}else setView({...view,x:view.x-e.deltaX,y:view.y-e.deltaY})}} onKeyDown={e=>{if((e.target as HTMLElement).closest('input,textarea,[contenteditable=true]'))return;if(placingAnnotation){if(e.key==='Escape'){e.preventDefault();setPlacingAnnotation(false)}return}if((e.key==='Delete'||e.key==='Backspace')&&!p.disabled){e.preventDefault();remove()}if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))nudge(e);if(e.key==='Escape'){setSelectedNote('');setEditingNote('');setLink(undefined);p.onSelect([]);setContext(undefined)}if(!e.metaKey&&!e.ctrlKey&&!e.altKey){if(e.key.toLowerCase()==='v')setMode('pointer');if(e.key.toLowerCase()==='h')setMode('hand')}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){e.preventDefault();setSelectedNote('');setSelectedEdge('');p.onSelect(nodes.map(n=>n.id))}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!p.disabled){e.preventDefault();e.shiftKey?p.onRedo():p.onUndo()}}}>
      <div className="vdw-world" style={{transform:`translate(${view.x}px,${view.y}px) scale(${view.scale})`}}>
        <svg className="vdw-edges" aria-label={t('节点连线','Node connections')}>{visible.edges.map(({edge,path})=><g key={edge.id} className={selectedEdge===edge.id?'is-selected':''} onPointerDown={e=>e.stopPropagation()} onClick={()=>{setSelectedNote('');setSelectedEdge(edge.id);p.onSelect([])}}><path className="vdw-edge-hit" d={path}/><path className="vdw-edge" d={path}/></g>)}</svg>
        <svg className="vdw-edges vdw-note-links" style={{pointerEvents:'none'}} aria-label={t('便签连接','Note connections')}>{visibleNotes.filter(n=>n.anchorNodeId).map(note=>{const node=nodes.find(n=>n.id===note.anchorNodeId);if(!node)return null;const a=noteSize(note),b=nodeSize(node);return <line key={note.id} x1={note.x+a.width/2} y1={note.y+a.height/2} x2={node.x+b.width/2} y2={node.y+b.height/2} stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 5" opacity={.35}/>})}</svg>
        {visibleNotes.map(note=><StickyNote key={note.id} note={note} nodes={nodes} disabled={p.disabled} selected={selectedNote===note.id} editing={editingNote===note.id} onSelect={()=>{setSelectedNote(note.id);p.onSelect([])}} onEditingChange={editing=>setEditingNote(editing?note.id:'')} onChange={updateNote} onDelete={()=>deleteNote(note.id)} onDragStart={e=>beginNote(e,note)} onResizeStart={e=>beginNote(e,note,true)}/>)}
        {visible.nodes.map(node=><div key={node.id} role="button" tabIndex={0} aria-label={`${displayNodeNumber(node.number)} ${node.title}`} onFocus={()=>setFocusedNode(node.id)} onBlur={()=>setFocusedNode(undefined)} aria-pressed={selectedSet.has(node.id)} className={`vdw-node ${isContainer(node.kind)?'vdw-container-node':''} ${selectedSet.has(node.id)?'is-selected':''}`} style={{left:node.x,top:node.y,width:nodeSize(node).width,height:nodeSize(node).height}} onPointerDown={e=>begin(e,node)} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();setSelectedNote('');p.onSelect([node.id]);p.onConfigure(node.id)}if(e.key===' '){e.preventDefault();setSelectedNote('');p.onSelect(e.shiftKey?[...new Set([...p.selected,node.id])]:[node.id])}}} onContextMenu={e=>{e.preventDefault();setSelectedNote('');setSelectedEdge('');if(!p.selected.includes(node.id))p.onSelect([node.id]);setContext({x:e.clientX,y:e.clientY})}}>
          <div className="vdw-node-title"><NodeBadge kind={node.kind}/><strong title={`${displayNodeNumber(node.number)} · ${node.title}`}><span className="vdw-node-number">{displayNodeNumber(node.number)} · </span>{node.title}</strong><NodeReadinessWarning node={node} issues={p.readinessIssues??[]} onConfigure={()=>{p.onSelect([node.id]);p.onConfigure(node.id)}}/>{node.fixed&&<Glyph name="lock" size={12}/>}</div>
          {isModelNode(node.kind)&&<div className="vdw-model-strip"><Glyph name="brain" size={13}/><span>{node.config.model?.model||t('跟随 DSH','Follow DSH')}</span></div>}
          <div className="vdw-node-preview" title={nodeSummary(node)}>{nodeSummary(node)}</div>
          {isContainer(node.kind)&&<div className="vdw-container-inner"><div className="vdw-container-mini">{node.config.body?.nodes.slice(0,4).map(child=><span key={child.id}><NodeBadge kind={child.kind}/>{child.title}</span>)}</div><Button size="sm" variant="outline" onClick={()=>p.onEnter(node.id)}>{t('编辑内部流程 · {count} 个节点','Edit inner workflow · {count} nodes',{count:node.config.body?.nodes.length||0})}</Button></div>}
          <NodeBranches node={node}/>
          {node.kind!=='input'&&<button className={`vdw-port vdw-port-in ${link?'is-target':''}`} style={{top:nodeSize(node).height/2-5}} aria-label={t('连接至 {name}','Connect to {name}',{name:node.title})} disabled={p.disabled} onClick={()=>{if(link&&link.id!==node.id){const edge={id:newId(),source:link.id,target:node.id,port:link.port};if(!p.workflow.edges.some(e=>e.source===edge.source&&e.target===edge.target&&e.port===edge.port))p.onEdit({...p.workflow,edges:[...p.workflow.edges,edge]});setLink(undefined)}}}/>}
          {nodePorts(node).map(port=><button key={port.id} className={`vdw-port vdw-port-out ${link?.id===node.id&&link.port===port.id?'is-target':''}`} style={{top:portY(node,port.id)-5}} disabled={p.disabled} aria-label={`从 ${node.title}${port.id==='default'&&!port.label?'':` ${port.label}分支`}连接`} title={port.label} onClick={()=>{setLink({id:node.id,port:port.id});setMessage(t('点击目标节点左侧端口完成连接','Click the target input port to complete the connection'))}}/>)}

        </div>)}
        {box&&<div className="vdw-selection-box" style={{left:box.x,top:box.y,width:box.w,height:box.h}}/>}
      </div>
      {annotationMarkers.map(note=>{const x=view.x+note.point.x*view.scale,y=view.y+note.point.y*view.scale;if(x < -14||x > size.width+14||y < -14||y > size.height+14)return null;return <button key={note.id} className={`vdw-annotation-pin ${note.id===p.pendingAnnotation?.id?'is-pending':''}`} data-annotation-id={note.id} data-workflow-id={p.workflow.id} style={{left:x,top:y}} aria-label={t('编辑第 {number} 条注释','Edit annotation {number}',{number:note.number})} onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();const rect=e.currentTarget.getBoundingClientRect();p.onEditAnnotation(note.id,{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom})}}>{note.number}</button>})}
    </div>
    <div className="vdw-canvas-tools" aria-label={t('画布工具栏','Canvas toolbar')}>
      <Tool label="添加节点" name="plus" disabled={p.disabled} onClick={()=>{p.onCloseAdvanced?.();p.onCloseLibrary?.();setPalette(!palette)}}/>
      <Tool label={p.nested?"请返回主流程添加便签":"添加便签"} name="note" onClick={addNote} disabled={p.disabled||p.nested}/><i/>
      <Tool label="指针模式" name="pointer" pressed={mode==='pointer'} onClick={()=>setMode('pointer')}/><Tool label="手模式" name="hand" pressed={mode==='hand'} onClick={()=>setMode('hand')}/><i/>
      <Tool label="整理画布" name="arrange" onClick={arrange} disabled={p.disabled}/>{p.onTemplates&&<Tool label="工作流模板" name="list" onClick={()=>{setPalette(false);p.onCloseAdvanced?.();p.onTemplates?.()}}/>}
      {p.onAdvanced&&<Tool label="高级设置" name="settings" pressed={!!p.advancedTab} onClick={()=>{setPalette(false);p.onCloseLibrary?.();p.onAdvanced?.()}}/>}
      {p.onJson&&<Tool label="导入流程 JSON" name="upload" onClick={()=>{setPalette(false);p.onCloseAdvanced?.();p.onJson?.('import')}}/>}
      <Tool label="导出" name="download" onClick={()=>{setPalette(false);p.onCloseAdvanced?.();p.onCloseLibrary?.();p.onJson?p.onJson('export'):exportSvg(p.workflow)}}/>
    </div>
    {palette&&<NodePicker onClose={()=>setPalette(false)} onAdd={add} hasInput={nodes.some(n=>n.kind==='input')} inLoop={!!p.inLoop} api={p.api} workspaceId={p.workflow.workspaceId} sessionId={p.sessionId}/>}
    {p.advancedSettings}
    {p.libraryPanel}
    <div ref={topActions} className={`vdw-canvas-top-actions ${topMode==='overflow'?'is-collapsed':topMode==='icons'?'is-icon-only':''}`} aria-label={t('画布操作','Canvas actions')}><CanvasTopActions selectedCount={p.selected.length} disabled={p.disabled} placingAnnotation={placingAnnotation} collapsed={topMode==='overflow'} iconOnly={topMode==='icons'} onToggleAnnotation={()=>{setPlacingAnnotation(value=>!value);surface.current?.focus({preventScroll:true})}} onDuplicate={duplicate} onDelete={remove} onAgent={p.onAgent} onEnvironment={p.onEnvironment} onSystem={p.onSystem} variablePanel={p.variablePanel} onPolicy={p.onPolicy} executionActions={p.executionActions}/></div>
    {context&&<Menu open portal listClassName="vdw-menu" anchor={<span/>} getAnchorRect={()=>new DOMRect(context.x,context.y,1,1)} items={actions} onClose={()=>setContext(undefined)} onSelect={id=>{setContext(undefined);if(id==='note')placeAnnotation(context.x,context.y);if(id==='copy')duplicate();if(id==='template')p.onCreateTemplate?.();if(id==='delete')remove();if(id==='fixed'){const fixed=!p.workflow.nodes.filter(n=>p.selected.includes(n.id)).every(n=>n.fixed);p.onEdit({...p.workflow,nodes:p.workflow.nodes.map(n=>p.selected.includes(n.id)?{...n,fixed}:n)})}if(id==='about'){const n=p.workflow.nodes.find(n=>p.selected.includes(n.id));if(n){p.onConfigure(n.id);setMessage(definition(n.kind).description)}}}}/>}
    <div className={`vdw-minimap-shell ${showMinimap?'':'is-collapsed'}`}>
      {showMinimap?<><div className="vdw-minimap-header"><span>{t('流程缩略图','Workflow minimap')}</span><Tool side="top" label="收起缩略图" name="minus" onClick={()=>setMinimap(false)}/></div><MiniMap nodes={p.workflow.nodes} viewport={overviewView} width={overviewWidth} height={overviewHeight} onViewport={next=>{stopAnimation();setView(compact?{...next,y:next.y+overviewTop}:next)}}/></>:<Tool side="top" label="展开缩略图" name="arrange" onClick={()=>setMinimap(true)}/>}
    </div>
    <div className="vdw-canvas-bottom"><div className="vdw-floating"><Tool side="top" label="撤销" name="undo" disabled={!p.canUndo||p.disabled} onClick={p.onUndo}/><Tool side="top" label="重做" name="redo" disabled={!p.canRedo||p.disabled} onClick={p.onRedo}/><Button size="sm" icon={<Glyph name="history"/>} aria-label={t('运行记录','Run history')} onClick={p.onRunDetails}><span className="vdw-control-label">{t('运行记录','Run history')}</span></Button></div><div className="vdw-floating"><Tool side="top" label="缩小画布" name="minus" onClick={()=>{stopAnimation();setView(current=>({...current,scale:Math.max(.2,current.scale-.1)}))}}/><span>{Math.round(view.scale*100)}%</span><Tool side="top" label="放大画布" name="plus" onClick={()=>{stopAnimation();setView(current=>({...current,scale:Math.min(2,current.scale+.1)}))}}/><Tool side="top" label="适应画布" name="fit" onClick={()=>fit()}/></div></div>
    {placingAnnotation&&<button className="vdw-canvas-hint" onClick={()=>setPlacingAnnotation(false)}>{t('点击画布放置注释 · Esc 取消','Click the canvas to place an annotation · Esc to cancel')}</button>}
    {(link||message)&&<button className="vdw-canvas-hint" onClick={()=>{setLink(undefined);setMessage('')}}>{link?t('点击目标节点左侧端口连接 · Esc 取消','Click the target input port to connect · Esc to cancel'):t(message)}</button>}
  </div>
}
function Tool({label,name,onClick,disabled,pressed,side="right"}:{label:string;name:string;onClick:()=>void;disabled?:boolean;pressed?:boolean;side?:"right"|"top"|"bottom"}){const {t}=useLocale();return <Tooltip label={t(label)} portal side={side}><Button size="sm" className="vdw-icon-button" aria-label={t(label)} data-workflow-library-trigger={['工作流模板','导入流程 JSON','导出'].includes(label)||undefined} aria-pressed={pressed} disabled={disabled} onClick={onClick}><Glyph name={name}/></Button></Tooltip>}

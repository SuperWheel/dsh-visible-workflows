import { annotationEditorStyles } from '../client/annotation-editor.tsx'
import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {WorkflowApp} from '../client/app.tsx'
import {WorkflowStore} from '../client/store.ts'
import type {WorkflowAPI} from '../shared/types.ts'
import '../../.cache/preview/native-theme.css'
import {styles} from '../client/styles.ts'
import {installWorkflowMotion} from '../client/workflow-motion.ts'
const style=document.createElement('style');style.textContent=styles+annotationEditorStyles;document.head.appendChild(style)
window.addEventListener('pagehide',installWorkflowMotion(document),{once:true})
import './preview.css'

const api=new Proxy({} as WorkflowAPI,{get:(_,method:string)=>(...args:unknown[])=>fetch('/__workflow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,args})}).then(async r=>{const result=await r.json();if(!r.ok)throw new Error(result.error);return result.value})})
const store=new WorkflowStore(api)
void store.load()
function Preview(){
  const[mode,setMode]=useState<'full'|'side'>('full')
  return <div className="preview-shell"><nav className="preview-nav"><strong>deepseek <small>HARNESS</small></strong><div>工作区</div><button className="active" onClick={()=>{store.update({page:'library'});setMode('full')}}>工作流</button><p>浏览器验收<br/>真实流程保存与执行</p></nav><main className="preview-main">{mode==='side'&&<div className="preview-conversation"><h2>对话区域</h2><p>聊天引用和 Agent 调用将在桌面宿主中验收。</p></div>}<section className={mode==='side'?'preview-pane side':'preview-pane'}><WorkflowApp store={store} mode={mode} navigation={{toFull:()=>setMode('full'),toSide:()=>setMode('side'),openChat:()=>setMode('side'),openSettings:()=>store.update({error:'请在真实 DeepSeekHarness 设置中管理工作流预设。'}),getSessionId:()=>undefined}}/></section></main></div>
}
createRoot(document.getElementById('root')!).render(<Preview/> )

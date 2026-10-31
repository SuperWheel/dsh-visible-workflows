import { t, useLocale } from './i18n.ts'
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { type InputField, type WorkflowRun } from '../shared/types.ts'
import { Field, Select } from './controls.tsx'
import { Glyph } from './icons.tsx'
import { runQuestionStyles } from './run-question-style.ts'
export const questionKey=(run:WorkflowRun)=>`${run.id}/${run.waitingExecutionId||'inputs'}`
export function RunQuestion({run,onClose,onAnswer,onCancel,working,error}:{run:WorkflowRun;onClose:()=>void;onAnswer:(values:Record<string,string>)=>void;onCancel:()=>void;working:boolean;error:string}){useLocale();
 const [values,setValues]=useState<Record<string,string>>({}),[fileError,setFileError]=useState('')
 useEffect(()=>{setValues(Object.fromEntries((run.missingFields||[]).map(f=>[f.name,f.defaultValue||''])));setFileError('')},[questionKey(run)])
 const invalid=!!run.missingFields?.some(f=>f.required&&!values[f.name]?.trim())
 const actions=run.humanActions?.length?run.humanActions:[{id:'',label:t('提交并继续')}]
 const fields=(run.missingFields||[]).filter(f=>!f.hidden),title=run.waitingNodeId?t("等待人工处理"):t("补充运行所需信息")
 return <Modal open headless title={title} className="vdw-modal vdw-run-question" onClose={onClose}>
 <style>{runQuestionStyles}</style>
 <header className="vdw-run-question-heading"><h2>{title}</h2><Button type="button" size="sm" className="vdw-run-question-close" aria-label={t("稍后补充")} onClick={onClose}><Glyph name="close"/></Button></header>
 <div className="vdw-run-question-body" aria-busy={working}>
 <p className="vdw-muted">{run.workflowTitle}</p>{run.humanPrompt&&<div className="vdw-human-prompt">{run.humanPrompt}</div>}
 {!!fields.length&&<div className="vdw-run-question-fields">{fields.map((f,i)=><Field key={f.name} label={`${f.label||f.name}${f.required?' *':''}`} help={f.type==='json'?t("填写有效 JSON 对象或数组。"):f.type==='file'||f.type==='files'?t("选择文件，总大小不超过 2 MB；文档节点会提取文字。"):undefined}><QuestionField field={f} value={values[f.name]||''} onChange={v=>setValues(prev=>({...prev,[f.name]:v}))} onError={setFileError} disabled={working} autofocus={i===0}/></Field>)}</div>}
 {(error||fileError)&&<p className="vdw-error" role="alert">{fileError||error}</p>}
 </div>
 <footer className="vdw-run-question-footer"><Button type="button" variant="outline" size="sm" disabled={working} onClick={onCancel}>{t("取消运行")}</Button>{actions.map((a,i)=><Button type="button" size="sm" key={a.id} variant={i===0?'primary':'outline'} disabled={working||invalid||!!fileError} onClick={()=>onAnswer({...values,...(a.id?{__action:a.id}:{})})}>{a.label}</Button>)}</footer>
 </Modal>
}
function QuestionField({field:f,value,onChange,onError,disabled,autofocus}:{field:InputField;value:string;onChange:(v:string)=>void;onError:(e:string)=>void;disabled:boolean;autofocus:boolean}){useLocale();
 const [names,setNames]=useState('')
 if(f.type==='select'||f.type==='boolean')return <Select label={f.label||f.name} value={value} disabled={disabled} options={[{id:'',label:t("请选择")},...(f.type==='boolean'?[{id:'true',label:t("是（true）")},{id:'false',label:t("否（false）")}]:(f.options||[]).map(id=>({id,label:id})))]} onChange={onChange}/>
 if(f.type==='file'||f.type==='files')return <div className="vdw-file-input"><input aria-label={f.label||f.name} type="file" multiple={f.type==='files'} disabled={disabled} onChange={async e=>{const files=Array.from(e.target.files||[]);try{if(files.reduce((sum,f)=>sum+f.size,0)>2_000_000)throw new Error(t('所选文件总大小超过 2 MB，请减少文件或压缩内容。'));const result=await Promise.all(files.map(file=>new Promise<{name:string;mimeType:string;base64:string}>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,mimeType:file.type||'application/octet-stream',base64:String(reader.result).split(',')[1]||''});reader.onerror=()=>reject(new Error(t('读取 {name} 失败','Failed to read {name}',{name:file.name})));reader.readAsDataURL(file)})));onChange(files.length?JSON.stringify(f.type==='files'?result:result[0]):'');setNames(files.map(f=>f.name).join('、'));onError('')}catch(error){onChange('');setNames('');onError(String(error))}}}/>{names&&<small>{names}</small>}</div>
 if(f.type==='number'||f.type==='text')return <Input data-modal-autofocus={autofocus||undefined} type={f.type==='number'?'number':'text'} aria-label={f.label||f.name} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}/>
 return <textarea data-modal-autofocus={autofocus||undefined} aria-label={f.label||f.name} rows={4} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}/>
}

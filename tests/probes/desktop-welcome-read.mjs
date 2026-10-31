import { createHash } from 'node:crypto'

const MAIN_SHA256='10325004a1ddbd8118ed0607ea28d50a7b0d692dcaeb25a67a7d8aea9165019d'
const allowed=new Set(['settings/describe','llm/listConfigurableProviders','credentials/describe','account/getState'])

/** Execute the installed Electron welcome reader unchanged over its real local
 * HTTP RPC. Cookie/session material and returned values stay in memory. No
 * credential write, account mutation, model request or external fetch allowed. */
export async function verifyInstalledDesktopWelcomeRead(source,authenticatedUrl){
 const reject=()=>{throw Error('DESKTOP_WELCOME_READ_FAILED')}
 if(createHash('sha256').update(source).digest('hex')!==MAIN_SHA256)reject()
 const start=source.indexOf('//#region lib/types/account-backend.js'),end=source.indexOf('//#region lib/types/update-journal.js',start)
 if(start<0||end<start)reject()
 const module='import {randomUUID} from "node:crypto";\n'+source.slice(start,end)+'\nexport {connectDesktopWelcome};'
 const {connectDesktopWelcome}=await import('data:text/javascript;base64,'+Buffer.from(module).toString('base64'))
 const origin=new URL(authenticatedUrl).origin,cookies=new Map(),methods=[]
 if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))reject()
 const send=async(input,options={})=>{
  let target=new URL(input)
  for(let hop=0;hop<4;hop++){
   if(target.origin!==origin)reject()
   if(options.method==='POST'){
    const body=JSON.parse(options.body),method=target.pathname.slice('/api/'.length)
    if(!target.pathname.startsWith('/api/')||!allowed.has(method)||body.method!==method)reject()
    methods.push(method)
   }else if(options.method!==undefined&&options.method!=='GET')reject()
   const response=await fetch(target,{...options,headers:{...options.headers,...(cookies.size?{cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')}:{})},redirect:'manual',signal:AbortSignal.timeout(15000)})
   for(const value of response.headers.getSetCookie()){
    const pair=value.split(';',1)[0],index=pair.indexOf('=');if(index<=0)reject();cookies.set(pair.slice(0,index),pair.slice(index+1))
   }
   if([301,302,303,307,308].includes(response.status)){
    if(options.method==='POST')reject()
    const location=response.headers.get('location');await response.body?.cancel();if(!location)reject();target=new URL(location,target);continue
   }
   return response
  }
  return reject()
 }
 try{
  const welcome=await connectDesktopWelcome(authenticatedUrl,send)
  const value=await welcome.read()
  if(typeof value.loggedIn!=='boolean'||typeof value.hasApiKey!=='boolean'||typeof value.writable!=='boolean'||value.localePreference!==null&&typeof value.localePreference!=='string')reject()
  if(!methods.includes('settings/describe')||!methods.includes('llm/listConfigurableProviders')||!methods.includes('account/getState'))reject()
  return {passed:true,installedMainSha256:MAIN_SHA256,readMethods:[...new Set(methods)],configurationValuesRecorded:false}
 }catch{return reject()}
}

// Run with the installed Harness Electron-as-Node. Never uses status/manage/execute
// with a valid permit: no authentication, Keychain lookup, UI or HTTP is exercised.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root=fileURLToPath(new URL('..',import.meta.url))
const binary=path.join(root,'dist/Workflow OS Secret Broker.app/Contents/MacOS/WorkflowOSSecretBroker')
const env={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}
const checks=[]
const sha=data=>createHash('sha256').update(data).digest('hex')
const build=spawnSync('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',path.join(root,'.build-cache'),'Sources/Protocol.swift','Sources/SecretValue.swift','Sources/UseAuthorization.swift','Sources/ScopeMutationLock.swift','tests/main.swift','-o','.build-cache/protocol-tests'],{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:100000})
assert.equal(build.status,0,'PROTOCOL_TEST_COMPILE_FAILED')
const unit=spawnSync(path.join(root,'.build-cache/protocol-tests'),[],{env,encoding:'utf8',timeout:10000,maxBuffer:4096})
assert.equal(unit.status,0,'PROTOCOL_TEST_FAILED')
const unitReport=JSON.parse(unit.stdout);assert.equal(unitReport.status,'passed')
checks.push({name:'native-protocol-values-identity',passed:true,count:unitReport.checks})

const sources=Object.fromEntries(await Promise.all(['main.swift','KeychainStore.swift','SecurityGate.swift','Authorization.swift','Transport.swift'].map(async name=>[name,await readFile(path.join(root,'Sources',name),'utf8')])) )
assert(sources['KeychainStore.swift'].includes('evaluatePolicy(.deviceOwnerAuthentication,'))
assert(!sources['KeychainStore.swift'].includes('WithBiometrics'))
assert(sources['main.swift'].indexOf('if request.command == "probe" { emit')<sources['main.swift'].indexOf('let store = CredentialStore'))
assert(!sources['SecurityGate.swift'].includes('evaluatePolicy('))
assert(!sources['SecurityGate.swift'].includes('SecItem'))
assert(sources['main.swift'].includes('"粘贴", "paste:"'))
assert(!sources['main.swift'].includes('addLocalMonitorForEvents'))
assert(sources['Transport.swift'].includes('completionHandler(.cancel)'))
checks.push({name:'source-contract-no-global-policy-probe-no-secret-lookup-and-native-paste',passed:true})

const execute=sources['main.swift'].split('case "execute":')[1].split('default:')[0]
assert(!/prepareApp|alert\(|runModal|OwnerSession|authenticate|evaluatePolicy/.test(execute))
assert(execute.indexOf('readForAutomaticUse()')<execute.indexOf('ControlledRequest('))
assert(execute.indexOf('assertAutomaticUseAuthorized')<execute.indexOf('ControlledRequest('))
const status=sources['KeychainStore.swift'].split('func status()')[1].split('private func readPayload')[0]
assert(!status.includes('readPayload'))
const automatic=sources['KeychainStore.swift'].split('func readForAutomaticUse()')[1].split('func assertAutomaticUseAuthorized')[0]
assert(automatic.includes('withoutKeychainUI { try readPayload() }'))
assert(automatic.includes('AutomaticUseGate.load'))
const save=sources['KeychainStore.swift'].split('func save(')[1].split('func authorizeAutomaticUse')[0]
assert(save.indexOf('revokeAutomaticUse(session: session, mutation: mutation)')<save.indexOf('SecItemUpdate'))
assert(save.indexOf('credentialEpoch() == expectedEpoch')<save.indexOf('revokeAutomaticUse('))
assert(save.includes('epoch: UUID()'))
const granting=sources['KeychainStore.swift'].split('func authorizeAutomaticUse')[1].split('func revokeAutomaticUse')[0]
assert(granting.indexOf('session.require(scope)')<granting.indexOf('SecItemUpdate'))
assert(granting.indexOf('mutation.require(scope)')<granting.indexOf('SecItemUpdate'))
assert(sources['main.swift'].includes('defer { mutation.release() }'))
assert(sources['KeychainStore.swift'].includes('private init(context: LAContext, scope: Scope)'))
assert(sources['main.swift'].includes('保存并授权自动使用'))
assert.equal((sources['KeychainStore.swift'].match(/evaluatePolicy\(/g)||[]).length,1)
checks.push({name:'native-automatic-use-no-ui-gates-and-owner-session-mutation-contract',passed:true})

async function invoke({request={version:1,command:'probe'},mode='none',extraEnv={}}={}) {
  const input=JSON.stringify(request)
  return await new Promise((resolve,reject)=>{
    const child=spawn(binary,[],{shell:false,env:{...env,...extraEnv},stdio:['pipe','pipe','pipe',mode==='none'?'ignore':'pipe']})
    let stdout='',stderrBytes=0,handshake='',helloSeen=false
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('NATIVE_TEST_DEADLINE'))},10000)
    child.on('error',()=>{clearTimeout(timer);reject(Error('NATIVE_TEST_SPAWN_FAILED'))})
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>4096){child.kill('SIGKILL');reject(Error('NATIVE_OUTPUT_LIMIT'))}})
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length})
    child.stdin.on('error',()=>{})
    const channel=child.stdio[3]
    channel?.on('error',()=>{})
    channel?.on('data',chunk=>{
      handshake+=chunk
      if(!handshake.endsWith('\n')||helloSeen)return
      helloSeen=true
      let hello;try{hello=JSON.parse(handshake)}catch{child.kill('SIGKILL');return}
      assert.match(hello.challenge,/^[a-f0-9]{64}$/)
      if(mode==='eof'){channel.end();return}
      channel.write(JSON.stringify({version:1,challenge:hello.challenge,requestHash:mode==='wrong-hash'?'0'.repeat(64):sha(input),parentPid:process.pid})+'\n')
    })
    child.on('close',code=>{
      clearTimeout(timer);channel?.destroy()
      try{assert.equal(code,0);assert.equal(stderrBytes,0);const response=JSON.parse(stdout);resolve({response,helloSeen,closed:true})}catch{reject(Error('NATIVE_RESPONSE_INVALID'))}
    })
    child.stdin.end(input)
  })
}
for(const [name,args,expected] of [
  ['missing-private-channel',{},'runtime_unsafe'],
  ['wrong-request-binding',{mode:'wrong-hash'},'runtime_unsafe'],
  ['closed-private-channel',{mode:'eof'},'runtime_unsafe'],
  ['unexpected-environment',{mode:'valid',extraEnv:{OS_SECRET_SYNTHETIC_UNEXPECTED:'1'}},'runtime_unsafe'],
  ['reject-secret-in-protocol',{request:{version:1,command:'probe',value:'synthetic-value'}},'invalid_request'],
  ['reject-resolve-api',{request:{version:1,command:'resolve'}},'invalid_request'],
]){
  const result=await invoke(args);assert.deepEqual(result.response,name==='unexpected-environment'?{ok:true,available:false,code:expected}:{ok:false,code:expected});checks.push({name,passed:true,closed:result.closed})
}
const probe=await invoke({mode:'valid'})
assert.equal(probe.response.ok,true);assert.equal(typeof probe.response.available,'boolean')
assert(['available','authentication_failed','runtime_unsafe'].includes(probe.response.code))
assert.equal(probe.response.available,probe.response.code==='available')
checks.push({name:'bound-probe-closed-response-no-authentication-or-keychain-branch',passed:true,closed:probe.closed,available:probe.response.available,code:probe.response.code})
const report={at:new Date().toISOString(),status:'passed',checks,nativeBinarySha256:sha(await readFile(binary)),manifestSha256:sha(await readFile(path.join(root,'dist/integrity.json'))),authenticationInvoked:false,keychainReadOrWrite:false,uiUsed:false,networkCalled:false,productionModified:false,globalPolicyChanged:false,limitations:['Native user authentication, actual Keychain CRUD/CAS and native paste/view require human acceptance; source contracts and protocol tests do not establish those behaviors.','No protection against same-user arbitrary code is claimed.']}
await mkdir('.cache/os-secret-broker-20261017',{recursive:true})
await writeFile('.cache/os-secret-broker-20261017/results.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status:report.status,groups:checks.length,protocolAssertions:unitReport.checks,nativeDirectProcessesClosed:7,keychainReadOrWrite:false,authenticationInvoked:false}))

import {readFileSync} from 'node:fs'
import type {ToolChoice} from '../../../src/shared/types.ts'

export const r16Fixture=(name:'initial-args'|'repair-args'|'last-repair-args'|'feedback')=>JSON.parse(readFileSync(new URL(`./t23-r16-${name}.json`,import.meta.url),'utf8'))
// Exact native identities, no executable tools or model calls.
export const r16Tools=():ToolChoice[]=>['native:glob','native:read','native:write'].map(id=>({id,name:id,description:'离线 r16 工具目录',available:true,providerId:'native',providerName:'native',category:'plugin',inputSchema:{type:'object',additionalProperties:true}}))

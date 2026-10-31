// T05.8.3 / T05.9.3 Desktop recovery compositions. The offline rehearsal and
// the Desktop import bundles are compiled from these same forms.
import { templateIdForTool } from '../../src/shared/planning-node-templates.ts'

/** A human review node holds the run so the operator can stop it (cancelled);
 * the Desktop UI offers 创建恢复运行 only for failed, interrupted or cancelled runs. */
const review = (prompt: string) => ({ key: 'review', template: 'human', values: { prompt, fields: [], actions: [{ id: 'approve', label: '通过' }, { id: 'reject', label: '不通过' }] } })
function reviewed(title: string, forms: any[], prefix: string[]) {
  return { submission: { mode: 'create', title, forms, chains: [{ key: 'prefix', nodes: [...prefix, 'review'] }],
    links: [{ key: 'approved', source: 'review', target: 'result', port: 'approve' }], coverage: { R1: [...prefix.slice(1), 'review', 'result'] } } }
}

/** Child: the builtin clock is a dynamic dependency, so a caller cache never reuses it. */
export const DYNAMIC_CHILD_TITLE = 'T05.8.3 动态时钟子流程'
export function dynamicChildWire() {
  return { submission: { mode: 'create', title: DYNAMIC_CHILD_TITLE, forms: [
    { key: 'start', template: 'input', values: { fields: [{ name: 'marker', label: '标记', required: true }] } },
    { key: 'clock', template: templateIdForTool('builtin:time.timestamp'), values: { inputs: {} } },
    { key: 'result', template: 'output', values: { text: '{{input.marker}}:{{clock.seconds}}', outputName: 'result' } },
  ], chains: [{ key: 'main', nodes: ['start', 'clock', 'result'] }], coverage: { R1: ['clock', 'result'] } } }
}
export const DYNAMIC_ROOT_TITLE = 'T05.8.3 缓存调用动态子流程'
export function dynamicRootWire(childId: string) {
  return reviewed(DYNAMIC_ROOT_TITLE, [
    { key: 'start', template: 'input', values: { fields: [{ name: 'marker', label: '标记', required: true }] } },
    { key: 'child', template: templateIdForTool(`workflow:${childId}`), values: { inputs: { marker: '{{input.marker}}' }, cache: 'reuse' } },
    review('核对子流程结果 {{child.outputs.result}}'),
    { key: 'result', template: 'output', values: { text: '{{child.outputs.result}}', outputName: 'result' } },
  ], ['start', 'child'])
}

/** v1 is the run snapshot; the saved library later moves to v2 and must not be used by recovery. */
export const DOCUMENT_TITLE = 'T05.9.3 附件读取与恢复'
export const DOCUMENT_V2_TEXT = 'v2 LATEST LIBRARY MUST NOT BE USED'
export function documentWire() {
  return reviewed(DOCUMENT_TITLE, [
    { key: 'start', template: 'input', values: { fields: [{ name: 'file', label: '附件', type: 'file', required: true }] } },
    { key: 'document', template: 'document', values: { source: 'input.file' } },
    review('核对附件内容'),
    { key: 'result', template: 'output', values: { text: 'v1:{{document.text}}', outputName: 'result' } },
  ], ['start', 'document'])
}

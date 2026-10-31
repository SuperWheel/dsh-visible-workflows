import test from 'node:test'
import assert from 'node:assert/strict'
import { currentWorkflowPackageFiles } from './install-current-workflow.mjs'

const paths = [
  'lib/index.js', 'lib/client.js', 'lib/typert.host.js', 'lib/typert.remote-client.js',
  'native/os-secret-broker/dist/integrity.json',
  'native/os-secret-broker/dist/Workflow OS Secret Broker.app/Contents/MacOS/WorkflowOSSecretBroker',
]

test('current package requires no retired global interception assets', () => {
  assert.deepEqual(currentWorkflowPackageFiles({ files: paths.map(path => ({ path })) }), paths)
})

for (const missing of paths) test(`rejects a package missing ${missing}`, () => {
  assert.throws(() => currentWorkflowPackageFiles({ files: paths.filter(path => path !== missing).map(path => ({ path })) }), /Incomplete package/)
})

test('old interception assets cannot replace the current OS credential component', () => {
  const retired = ['lib/isolation-host.js', 'lib/workflow-file-worker.js', 'native/mxc/manifest.json']
  assert.throws(() => currentWorkflowPackageFiles({ files: [...paths.slice(0, 4), ...retired].map(path => ({ path })) }), /Incomplete package/)
})

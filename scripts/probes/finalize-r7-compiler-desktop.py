"""Check the recorded R7 Desktop chain against live files without replaying work."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/evidence/r7-compiler-desktop-20261019'
STAGE = ROOT / '.cache/planning-entry-20261019-compiler'
STATE = Path.home() / '.dsh/visible-dynamic-workflows'
WORKSPACE = Path('/private/tmp/dsh-workflow-r7-acceptance-20261018')
WORKFLOW = 'af665243-1a04-4486-9914-3793161532b6'


def read(path):
    return json.loads(path.read_text())


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True).encode())


def ms(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def compare(items, baseline, key='id'):
    current = {item[key]: item for item in items}
    return {key: key in current and canonical(current[key]) == digest for key, digest in baseline.items()}


baseline = read(STAGE / 'data-before.json')
library = read(STATE / 'library.json')
editor = read(STATE / 'editor-state.json')
plans = read(STATE / 'planning/tasks.json')['tasks']
trials = read(STATE / 'trials/planning/tasks.json')['tasks']
preservation = {
    'workflows': compare(library['workflows'], baseline['workflowHashes']),
    'planningTasks': compare(plans, baseline['planningHashes']),
    'trials': compare(trials, baseline['trialHashes']),
    'editor': {group: compare(editor.get(group, []), hashes, 'key' if group == 'planningReceipts' else 'id')
               for group, hashes in baseline['editorHashes'].items()},
    'historyFiles': {name: (STATE / name).is_file() and sha((STATE / name).read_bytes()) == digest
                     for name, digest in baseline['files'].items() if name.startswith(('runs/', 'history/'))},
    'presetsUnchanged': canonical(library['presets']) == baseline['presetHash'],
    'cordis': {name: sha((Path.home() / '.dsh/profiles/desktop' / name).read_bytes()) == baseline['profileHashes'][name]
               for name in ['cordis.yml', 'cordis.patch.yml']},
    'originalWorkspaceFiles': {name: sha((WORKSPACE / name).read_bytes()) == digest
                               for name, digest in baseline['workspaceFiles'].items()},
}


def all_true(value):
    return all(all_true(item) for item in value.values()) if isinstance(value, dict) else value is True


assert all_true(preservation), 'Original state changed: inspect preservation evidence'
assert len(trials) == len(baseline['trialHashes']) == 1, 'Trial was repeated'
source = read(STAGE / 'source-manifest.json')
source_checks = {name: (ROOT / name).is_file() and sha((ROOT / name).read_bytes()) == digest
                 for name, digest in source['sourceHashes'].items()}
assert all(source_checks.values()), 'Frozen production source changed during acceptance'
installed = Path.home() / '.dsh/profiles/desktop/node_modules/dsh-visible-dynamic-workflows'
installation = read(OUT / 'installation.json')
bundle_checks = {name: sha((installed / name).read_bytes()) == digest for name, digest in installation['bundleHashes'].items()}
assert all(bundle_checks.values())
save('preservation-final.json', {'checkedAt': datetime.now(timezone.utc).isoformat(), 'checks': preservation,
                                'allCapturedOriginalDataPreserved': True, 'trialCount': len(trials),
                                'frozenSourceFilesUnchanged': len(source_checks), 'installedBundles': bundle_checks})

tasks = read(OUT / 'planning-tasks.json')
runs = read(OUT / 'graphon-runs.json')
native = read(OUT / 'native-public-events.json')
flow = next(flow for flow in library['workflows'] if flow['id'] == WORKFLOW)
assert flow['revision'] == 2 and len(flow['nodes']) == 11
assert len(runs) == 3 and [run['status'] for run in runs] == ['failed', 'success', 'success']
assert [run['sourceRevision'] for run in runs] == [1, 2, 2]
assert all(run['engine']['name'] == 'graphon' for run in runs)
results = []
for case, run in zip(['primary', 'holdout'], runs[1:]):
    file_check = read(OUT / f'{case}-file-verification.json')
    assert file_check['passed'] and Path(run['inputs']['outputDir']) == Path(file_check['outputDirectory'])
    assert run['graph'] == flow and all(node['status'] == 'success' for node in run['executions'])
    assert all(run['budget'][key] == 0 for key in ['calls', 'agentTasks', 'spentTokens', 'unknownCalls', 'unknownTokens'])
    executions = {node['nodeId']: node for node in run['executions']}
    human = next(node for node in flow['nodes'] if node['kind'] == 'human')
    assert executions[human['id']]['data']['__action_id'] == 'approve'
    file_receipts = {}
    for filename in ['summary.json', 'report.md']:
        actual_path = Path(file_check['outputDirectory']) / filename
        actual = actual_path.read_text()
        write_node = next(node for node in flow['nodes'] if node['title'] == '写入 ' + filename)
        read_node = next(node for node in flow['nodes'] if node['title'] == '回读 ' + filename)
        write_input = json.loads(executions[write_node['id']]['input'])
        read_output = executions[read_node['id']]['data']['value']
        assert write_input['file_path'] == str(actual_path) and write_input['content'] == actual
        assert read_output['path'] == str(actual_path) and read_output['offset'] == 1
        assert read_output['totalLines'] == len(read_output['lines'])
        assert [line['text'] for line in read_output['lines']] == actual.splitlines()
        assert sha(actual_path.read_bytes()) == file_check['artifacts'][filename]['sha256']
        file_receipts[filename] = {'writeAndReadbackMatchActualFile': True, 'sha256': sha(actual_path.read_bytes())}
    transitions = []
    for event in run['events']:
        if not transitions or event['status'] != transitions[-1]['status']:
            transitions.append({'at': event['at'], 'status': event['status']})
    assert [item['status'] for item in transitions] == ['waiting', 'running', 'waiting', 'running', 'success']
    input_wait = ms(transitions[1]['at']) - ms(transitions[0]['at'])
    human_wait = ms(transitions[3]['at']) - ms(transitions[2]['at'])
    active = (ms(transitions[2]['at']) - ms(transitions[1]['at'])
              + ms(transitions[4]['at']) - ms(transitions[3]['at']))
    results.append({'case': case, 'runId': run['id'], 'status': run['status'], 'sourceRevision': run['sourceRevision'],
                    'startedAt': run['startedAt'], 'endedAt': run['endedAt'],
                    'wallMs': round(ms(run['endedAt']) - ms(run['startedAt']), 3),
                    'inputFormWaitingMs': round(input_wait, 3), 'humanWaitingMs': round(human_wait, 3),
                    'activeStatusMs': round(active, 3), 'statusTransitions': transitions,
                    'fileReceipts': file_receipts, 'all11NodesSucceeded': True, 'budget': run['budget']})
usage = []
for session in native['sessions']:
    messages = [event for event in session['events'] if event['type'] == 'assistant/message']
    usage.append({'sessionId': session['id'], 'role': session['role'], 'observedModelResponses': len(messages),
                  'reportedTotalTokens': sum(event['usage']['totalTokens'] for event in messages if event.get('usage')),
                  'responsesWithUnknownUsage': sum(event.get('usage') is None for event in messages)})
end = runs[-1]['endedAt']
summary = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'workflowId': WORKFLOW, 'workflowRevision': flow['revision'],
           'formatVersion': read(OUT / 'generated-v2.workflow.json')['formatVersion'], 'engine': runs[-1]['engine'],
           'chainStart': datetime.fromtimestamp(native['startedAt'] / 1000, timezone.utc).isoformat(), 'chainEnd': end,
           'chainWallMs': round(ms(end) - native['startedAt'], 3),
           'chainBoundary': '原生恢复消息至独立样本整图完成；含候选审阅、失败、局部修复、UI 操作、人工等待；不含前置安装准备和历史试做。',
           'preflightToCompletionMs': round(ms(end) - ms(baseline['capturedAt']), 3),
           'installedAt': installation['installation']['at'],
           'trialRepeated': False, 'originalStatePreserved': True, 'runs': results,
           'initialFailedRun': {'id': runs[0]['id'], 'error': runs[0]['error'],
                                'wallMs': round(ms(runs[0]['endedAt']) - ms(runs[0]['startedAt']), 3)},
           'successRates': {'revision1FirstAttempt': '0/1', 'revision2Cases': '2/2', 'allCreatedRuns': '2/3',
                            'concurrentRejectedRequests': 1, 'rejectedReviseRequestWithOptimizationTarget': 1},
           'planningReportedTokens': sum(task['spentTokens'] for task in tasks),
           'modelUsageBySession': usage,
           'totalReportedModelTokens': sum(row['reportedTotalTokens'] for row in usage),
           'modelResponsesWithUnknownUsage': sum(row['responsesWithUnknownUsage'] for row in usage),
           'limitations': ['两个合成样本不能证明所有输入泛化。', '未知用量未填零；Token 不是费用。',
                           'activeStatusMs 是事件状态 running 的累计墙钟区间，包含调度和恢复；不是 CPU 时间。',
                           '旧 R7 没有完成同条件整图，不能由此计算相对旧版的端到端提速比例。']}
save('final-summary.json', summary)
print(json.dumps(summary, ensure_ascii=False, indent=2))

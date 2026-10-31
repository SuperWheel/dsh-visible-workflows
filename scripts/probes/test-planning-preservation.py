#!/usr/bin/env python3
"""Synthetic-only regression tests; never invokes the fixed-profile backup CLI."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

snapshot = load('snapshot_test', 'snapshot-planning-data-preservation.py')
backup = load('backup_test', 'backup-planning-state.py')

class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='s10-preservation-test-', dir='/private/tmp')
        self.base = Path(self.temporary.name)
        self.root = self.base / 'state'
        self.root.mkdir()
        self.write('library.json', {'workflows': [{'id':'old-flow','title':'private history'}], 'presets': [], 'planningReceipts':[]})
        self.write('editor-state.json', {'proposals':[{'id':'old-proposal','workflowId':'old-flow','state':'pending'}], 'drafts':[], 'planningReceipts':[]})
        self.write('planning/tasks.json', {'tasks':[{'id':'old-task','sessionId':'old-session','state':'published','request':{'instruction':'private instruction'}}]})
        self.write('runs/old-run.json', {'id':'old-run','status':'success','inputs':{'text':'private input'}})
        self.write('history/old.json', {'private':'history'})
        self.write('creation-budgets/budget.json', {'workflowId':'old-flow'})
        self.write('credentials.json', {'token':'SHOULD_NOT_EXPORT'})

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def test_snapshot_hash_only_scope_and_complete_entities(self):
        before, editor, tasks, summary = snapshot.capture(self.root)
        self.assertEqual(len(before['files']), 6)
        self.assertEqual(set(before['workflowHashes']), {'old-flow'})
        self.assertEqual(set(editor['hashes']['proposals']), {'old-proposal'})
        self.assertEqual(set(tasks['hashes']['tasks']), {'old-task'})
        self.assertEqual(summary['counts']['creation-budgets'], 1)
        public = json.dumps([before, editor, tasks, summary])
        for text in ['SHOULD_NOT_EXPORT', 'private history', 'private instruction', 'private input']:
            self.assertNotIn(text, public)

    def test_rejects_symlink_file_and_parent(self):
        (self.root / 'runs/link').symlink_to(self.root / 'credentials.json')
        with self.assertRaises(ValueError):
            snapshot.capture(self.root)
        (self.root / 'runs/link').unlink()
        linked = self.base / 'linked-root'
        linked.symlink_to(self.root)
        with self.assertRaises(ValueError):
            snapshot.capture(linked)

    def test_activity_report_includes_current_model_and_cleanup_states(self):
        active = ['authoring', 'distilling', 'repairing', 'optimizing', 'regressing', 'cancelling', 'awaiting_input']
        terminal = ['ready', 'published', 'cancelled', 'interrupted', 'failed']
        self.write('planning/tasks.json', {'tasks': [{'id': state, 'state': state} for state in active + terminal]})
        summary = snapshot.capture(self.root)[3]
        self.assertEqual(summary['activePlanningTaskIds'], active)
        self.assertIn('in-memory preview', summary['planningActivityScope'])

    def verifier_fixture(self):
        before, editor, task, _ = snapshot.capture(self.root)
        profile = self.base / 'profile'
        profile.mkdir()
        for name in ['cordis.yml','cordis.patch.yml']:
            (profile / name).write_text('synthetic config')
        installation = {'target':str(profile / 'plugins/plugin'), 'profile': {name:snapshot.sha((profile / name).read_bytes()) for name in ['cordis.yml','cordis.patch.yml']}}
        for name, value in [('before',before),('editor',editor),('task',task),('install',installation)]:
            (self.base / (name+'.json')).write_text(json.dumps(value))

    def verify(self, task_flag=False):
        command = [sys.executable,str(HERE / 'verify-planning-data-preservation.py'),str(self.base/'before.json'),str(self.base/'install.json'),'--entity-baseline',str(self.base/'editor.json')]
        if task_flag:
            command += ['--task-entity-baseline',str(self.base/'task.json')]
        result = subprocess.run(command, capture_output=True, text=True)
        return result.returncode, json.loads(result.stdout)

    def test_optional_task_entity_check_preserves_legacy_and_detects_mutation(self):
        self.verifier_fixture()
        self.assertEqual(self.verify()[0], 0)
        self.assertEqual(self.verify(True)[0], 0)
        self.write('planning/tasks.json', {'tasks':[{'id':'old-task','sessionId':'old-session','state':'failed'}]})
        self.assertEqual(self.verify()[0], 0)  # Old calls retain their old boundaries.
        code, result = self.verify(True)
        self.assertEqual(code, 1)
        self.assertFalse(result['checks']['originalPlanningTaskEntitiesUnchanged'])

    def test_task_entity_check_allows_new_task_without_old_entity_mutation(self):
        self.verifier_fixture()
        current = json.loads((self.root/'planning/tasks.json').read_text())
        current['tasks'].append({'id':'synthetic-new-task','state':'queued'})
        self.write('planning/tasks.json',current)
        code, result = self.verify(True)
        self.assertEqual(code,0)
        self.assertTrue(result['checks']['originalPlanningTaskEntitiesUnchanged'])

    def test_optional_mode_includes_old_budget_files_in_overall_result(self):
        self.verifier_fixture()
        self.write('creation-budgets/budget.json', {'workflowId':'changed'})
        code,result = self.verify(True)
        self.assertEqual(code,1)
        self.assertFalse(result['checks']['originalBudgetFilesUnchanged'])

    def test_private_backup_using_fake_state_only(self):
        before,_,_,_ = snapshot.capture(self.root)
        destination = self.base/'private/state-backup'
        result = backup.backup(self.root,destination,before)
        self.assertTrue(result['hashesVerified'])
        self.assertFalse((destination/'credentials.json').exists())
        self.assertEqual(os.stat(destination).st_mode & 0o777,0o700)
        self.assertEqual(os.stat(destination/'planning/tasks.json').st_mode & 0o777,0o600)
        self.assertEqual((destination/'history/old.json').read_bytes(),(self.root/'history/old.json').read_bytes())
        with self.assertRaises(ValueError):
            backup.backup(self.root,destination,before)

    def test_private_backup_fails_if_state_changed_or_destination_symlink(self):
        before,_,_,_ = snapshot.capture(self.root)
        self.write('runs/new.json',{'id':'new','status':'success'})
        with self.assertRaises(ValueError):
            backup.backup(self.root,self.base/'not-created',before)
        self.assertFalse((self.base/'not-created').exists())
        link=self.base/'linked-destination';link.symlink_to(self.base/'elsewhere')
        with self.assertRaises(ValueError):
            backup.backup(self.root,link,before)

if __name__ == '__main__':
    unittest.main()

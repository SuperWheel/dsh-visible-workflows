"""Read actual generated-graph artifacts; never execute or rewrite the business task."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKSPACE = Path('/private/tmp/dsh-workflow-r7-acceptance-20261018')
STATE = Path.home() / '.dsh/visible-dynamic-workflows'
EVIDENCE = ROOT / 'docs/evidence/r7-compiler-desktop-20261019'
CASES = {
    'primary': ('orders.json', 'r7-compiler-primary', {'paidCount': 3, 'totalCents': 4000, 'byCategory': {'book': 3700, 'food': 300}}),
    'holdout': ('orders-holdout.json', 'r7-compiler-holdout', {'paidCount': 3, 'totalCents': 800, 'byCategory': {'book': 100, 'food': 700}}),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(case):
    source, directory, expected = CASES[case]
    output = WORKSPACE / directory
    baseline = json.loads((ROOT / '.cache/planning-entry-20261019-compiler/data-before.json').read_text())
    old_files = {name: (WORKSPACE / name).is_file() and digest((WORKSPACE / name).read_bytes()) == sha
                 for name, sha in baseline['workspaceFiles'].items()}
    result = {'case': case, 'checkedAt': datetime.now(timezone.utc).isoformat(), 'input': source,
              'outputDirectory': str(output), 'expected': expected, 'originalWorkspaceFilesUnchanged': old_files,
              'checks': {}, 'artifacts': {}}
    for name in ['summary.json', 'report.md']:
        p = output / name
        result['checks'][name + 'Exists'] = p.is_file() and not p.is_symlink()
        if not result['checks'][name + 'Exists']:
            continue
        raw = p.read_bytes()
        result['artifacts'][name] = {'sha256': digest(raw), 'bytes': len(raw)}
        if name == 'summary.json':
            actual = json.loads(raw)
            result['actualSummary'] = actual
            result['checks']['summaryExactFieldsAndValues'] = actual == expected
            result['checks']['summaryIntegerFields'] = type(actual.get('paidCount')) is int and type(actual.get('totalCents')) is int and all(type(v) is int for v in actual.get('byCategory', {}).values())
        else:
            text = raw.decode('utf-8')
            lines = [x.strip() for x in text.splitlines() if x.strip()]
            required = ['# 已支付订单汇总', f"笔数：{expected['paidCount']}", f"总额（分）：{expected['totalCents']}"]
            category_lines = [f'{key}：{value}' for key, value in expected['byCategory'].items()]
            result['actualReport'] = text
            result['checks']['reportFixedHeaderAndCounts'] = lines[:3] == required
            result['checks']['reportCategoriesAndNoExtraCopy'] = len(lines) == len(required) + len(category_lines) and sorted(lines[3:]) == sorted(category_lines)
        (EVIDENCE / f'{case}-{name}').write_bytes(raw)
    result['passed'] = all(result['checks'].values()) and all(old_files.values())
    result['boundary'] = 'Actual output file check only. A passing check does not claim that a still-waiting human node or the whole Graphon run has completed.'
    (EVIDENCE / f'{case}-file-verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', choices=CASES)
    args = parser.parse_args()
    result = verify(args.case)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['passed'] else 1)

#!/usr/bin/env python3
"""Summarize complete paired runs; never silently omit failed or missing trials."""
import argparse
import hashlib
import json
import math
import random
import statistics
from pathlib import Path


def percentile(values, p):
    if not values:
        return None
    values = sorted(values)
    pos = (len(values) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    return values[lo] + (values[hi] - values[lo]) * (pos - lo)


def median(values):
    return statistics.median(values) if values else None


def read_experiment(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    rows = [json.loads(line) for line in (directory / 'results.jsonl').read_text().splitlines()]
    expected = {(c, g, r) for c in manifest['cases'] for g in manifest['groups'] for r in range(manifest['repeats'])}
    actual = [(r['case'], r['group'], r['repeat']) for r in rows]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise ValueError(f'Incomplete or duplicate experiment: {directory}: {len(actual)}/{len(expected)} rows')
    if (directory / 'disposition.json').exists():
        raise ValueError(f'Development experiment is excluded: {directory}')
    return manifest, rows


def aggregate(rows):
    groups = {}
    for group in sorted({row['group'] for row in rows}):
        selected = [r for r in rows if r['group'] == group]
        successes = [r for r in selected if r['success']]
        calls = [c for r in selected for c in r['calls']]
        known = [c['usage'] for c in calls if c.get('usage') is not None]
        tokens = {}
        for key in ['prompt_tokens', 'completion_tokens', 'total_tokens']:
            reported = [u[key] for u in known if isinstance(u.get(key), (int, float))]
            tokens[key] = {'sumReported': sum(reported), 'unknownCalls': len(calls) - len(reported)}
        cached = [u.get('prompt_tokens_details', {}).get('cached_tokens') for u in known]
        tokens['cached_tokens'] = {'sumReported': sum(v for v in cached if isinstance(v, (int, float))),
                                  'unknownCalls': len(calls) - sum(isinstance(v, (int, float)) for v in cached)}
        reasoning = [u.get('completion_tokens_details', {}).get('reasoning_tokens') for u in known]
        tokens['reasoning_tokens'] = {'sumReported': sum(v for v in reasoning if isinstance(v, (int, float))),
                                     'unknownCalls': len(calls) - sum(isinstance(v, (int, float)) for v in reasoning)}
        groups[group] = {
            'attempted': len(selected), 'succeeded': len(successes),
            'successRate': len(successes) / len(selected),
            'structureSucceeded': sum(bool(r.get('structureSuccess')) for r in selected),
            'successMedianSeconds': median([r['totalMs'] / 1000 for r in successes]),
            'successP95Seconds': percentile([r['totalMs'] / 1000 for r in successes], .95),
            'totalSeconds': sum(r['totalMs'] for r in selected) / 1000,
            'secondsPerSuccessIncludingFailures': sum(r['totalMs'] for r in selected) / 1000 / len(successes) if successes else None,
            'meanModelRequests': statistics.mean(r['requests'] for r in selected),
            'meanMetadataCalls': statistics.mean([r['catalogCalls'] for r in selected if 'catalogCalls' in r]) if any('catalogCalls' in r for r in selected) else None,
            'modelRequests': sum(r['requests'] for r in selected),
            'medianSubmissions': median([r['submissions'] for r in selected if 'submissions' in r]),
            'meanActivations': statistics.mean([r['activations'] for r in selected if 'activations' in r]) if any('activations' in r for r in selected) else None,
            'medianInputBytes': median([r['inputBytes'] for r in selected]),
            'medianOutputArgumentBytes': median([r.get('outputBytes', 0) for r in selected]),
            'successMedianCompileMs': median([r['compileMs'] for r in successes if 'compileMs' in r]),
            'medianFirstObservedDeltaMs': median([c['firstDeltaMs'] for c in calls if isinstance(c.get('firstDeltaMs'), (int, float))]),
            'knownUsageCalls': len(known), 'unknownUsageCalls': len(calls) - len(known), 'tokens': tokens,
        }
    return groups


def compare(rows, left, right):
    by_key = {(r['case'], r['group'], r['repeat']): r for r in rows}
    pairs = []
    for (case, group, repeat), baseline in by_key.items():
        if group != left:
            continue
        candidate = by_key[(case, right, repeat)]
        pairs.append({'case': case, 'repeat': repeat, 'leftSuccess': baseline['success'], 'rightSuccess': candidate['success'],
                      'leftSeconds': baseline['totalMs'] / 1000, 'rightSeconds': candidate['totalMs'] / 1000,
                      'ratio': candidate['totalMs'] / baseline['totalMs'] if baseline['success'] and candidate['success'] else None})
    valid = [p for p in pairs if p['ratio'] is not None]
    ratio = math.exp(statistics.mean(math.log(p['ratio']) for p in valid)) if valid else None
    # Resample distinct task cases, not the correlated repeated calls as independent cases.
    clusters = {case: [math.log(p['ratio']) for p in valid if p['case'] == case] for case in sorted({p['case'] for p in valid})}
    bootstrap = []
    if len(clusters) >= 4:
        rng = random.Random(20261018)
        for _ in range(10000):
            sample = [value for case in rng.choices(list(clusters), k=len(clusters)) for value in clusters[case]]
            bootstrap.append(math.exp(statistics.mean(sample)))
    return {'left': left, 'right': right, 'allPairs': len(pairs), 'bothSucceeded': len(valid),
            'distinctSuccessfulCases': len(clusters), 'geometricMeanTimeRatio': ratio,
            'geometricMeanReduction': 1 - ratio if ratio is not None else None,
            'taskClusterBootstrapRatio95': [percentile(bootstrap, .025), percentile(bootstrap, .975)] if bootstrap else None,
            'onlyLeftSucceeded': sum(p['leftSuccess'] and not p['rightSuccess'] for p in pairs),
            'onlyRightSucceeded': sum(p['rightSuccess'] and not p['leftSuccess'] for p in pairs),
            'neitherSucceeded': sum(not p['leftSuccess'] and not p['rightSuccess'] for p in pairs), 'pairs': pairs}


def summarize(directory):
    manifest, rows = read_experiment(directory)
    checks = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() == digest for p, digest in manifest['implementationHashes'].items()}
    if not all(checks.values()):
        raise ValueError('Measured implementation differs from current source: ' + ', '.join(p for p, ok in checks.items() if not ok))
    comparisons = [compare(rows, 'A', 'D')]
    if manifest['groups'] == ['A', 'B', 'C', 'D']:
        comparisons += [compare(rows, a, b) for a, b in [('A', 'B'), ('A', 'C'), ('B', 'D'), ('C', 'D')]]
    failures=[]
    for row in rows:
        if row['success']:
            continue
        detail=json.loads((directory/f'{row["case"]}-{row["group"]}-{row["repeat"]}.json').read_text())
        failed={k:row.get(k) for k in ['case','group','repeat','error','oracle','totalMs','requests','submissions']}
        feedback=detail.get('feedback',[])
        last=feedback[-1] if isinstance(feedback,list) and feedback else feedback
        failed['lastDiagnostics']=last.get('issues',[]) if isinstance(last,dict) else last
        failures.append(failed)
    return {'directory': str(directory), 'manifest': manifest, 'completeRows': len(rows),
            'currentImplementationHashesMatch': checks, 'groups': aggregate(rows), 'comparisons': comparisons,
            'failures': failures}


def number(value):
    return '—' if value is None else f'{value:.1f}'


def markdown(authoring, recovery):
    lines = ['# 编译器真实对照数据汇总', '', '由脚本生成；报告解释见 REPORT.md。失败不进入成功耗时分位数，但计入成功率与单位成功任务总耗时。', '',
             '| 组 | 成功/总数 | 成功率 | 成功耗时中位数/秒 | P95/秒 | 平均模型请求 | 含失败成本秒/成功任务 |', '| --- | --- | --- | --- | --- | --- | --- |']
    for g, row in authoring['groups'].items():
        lines.append(f'| {g} | {row["succeeded"]}/{row["attempted"]} | {row["successRate"]:.1%} | {number(row["successMedianSeconds"])} | {number(row["successP95Seconds"])} | {row["meanModelRequests"]:.2f} | {number(row["secondsPerSuccessIncludingFailures"])} |')
    lines += ['', '## 相同任务双方均成功的配对', '', '| 比较 | 配对数 | 不同任务数 | 几何平均耗时比（右/左） | 按任务重采样的探索性 95% 区间 |', '| --- | --- | --- | --- | --- |']
    for pair in authoring['comparisons']:
        ci = pair['taskClusterBootstrapRatio95']
        ratio_text = f'{pair["geometricMeanTimeRatio"]:.3f}' if pair['geometricMeanTimeRatio'] is not None else '—'
        lines.append(f'| {pair["left"]} → {pair["right"]} | {pair["bothSucceeded"]}/{pair["allPairs"]} | {pair["distinctSuccessfulCases"]} | {ratio_text} | {f"{ci[0]:.3f}–{ci[1]:.3f}" if ci else "样本任务不足，不估计"} |')
    lines += ['', '区间只反映本组成功配对中的任务差异；六种任务不是总体代表样本，两次重复也不是独立业务案例。不能据此证明成功率 5 个百分点非劣或生产 P95。', '', '## R7 同一失败对象恢复', '', '| 组 | 保留业务且校验通过/总数 | 模型修复请求中位数/秒 | 输出参数中位数字节 |', '| --- | --- | --- | --- |']
    for g, row in recovery['groups'].items():
        lines.append(f'| {g} | {row["succeeded"]}/{row["attempted"]} | {number(row["successMedianSeconds"])} | {number(row["medianOutputArgumentBytes"])} |')
    lines += ['', '恢复请求从共同失败草稿之后计时，不含后续本地校验时间，也不包含原任务 311 秒生成时间；原暂停任务没有续跑。', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--authoring', type=Path, required=True)
    parser.add_argument('--recovery', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    authoring, recovery = summarize(args.authoring), summarize(args.recovery)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'summary.json').write_text(json.dumps({'authoring': authoring, 'recovery': recovery}, ensure_ascii=False, indent=2) + '\n')
    (args.out / 'SUMMARY.md').write_text(markdown(authoring, recovery))
    print(json.dumps({'authoringRuns': authoring['completeRows'], 'recoveryRuns': recovery['completeRows'], 'summary': str(args.out / 'SUMMARY.md')}, ensure_ascii=False))

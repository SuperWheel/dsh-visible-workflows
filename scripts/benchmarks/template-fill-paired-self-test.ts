/** Independent offline self-check: real compilers + local deterministic oracle, no provider. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { cases, contextFor, oracle } from './workflow-compiler.ts';
import { freezePair, runPaired, type Arm, type PairProvider } from './template-fill-paired.ts';

/** Offline fixture helper, also understands the journal's public cold resume. */
export function fixtureFeedback(body: Record<string, unknown>): any {
  const messages = body.messages as any[];
  const direct = messages.findLast(message => message.role === 'tool');
  if (direct) return direct;
  try { return JSON.parse(messages[1]?.content).completedMessages?.findLast((message: any) => message.role === 'tool'); }
  catch { return undefined; }
}

// Use a wrong type to exercise repair on both arms; missing titles now default in template mode.
export function greetingSubmission(arm: Arm, invalidTitle = false): any {
  const rows = [
    {
      key: 'start',
      kind: 'input',
      config: { fields: [{ name: 'name', label: '姓名', required: true }] }
    },
    {
      key: 'greet',
      kind: 'template',
      config: { text: '你好，{{input.name}}！' }
    },
    {
      key: 'result',
      kind: 'output',
      config: { text: '{{greet.text}}', outputName: 'result' }
    }
  ];
  return {
    submission: {
      mode: 'create',
      title: invalidTitle ? 42 : '离线问候',
      ...(arm === 'template-fill' ? {
        forms: rows.map(({ kind, config, ...node }) => ({ ...node, template: kind, values: config }))
      } : { nodes: rows }),
      chains: [{ key: 'main', nodes: ['start', 'greet', 'result'] }],
      coverage: { R1: ['greet', 'result'] }
    }
  };
}

export async function pairedSelfTest() {
  const item = cases.find(item => item.id === 'greeting')!,
    calls = new Map<string, number>();
  const provider: PairProvider = {
    async request(body, slot) {
      const count = (calls.get(slot.arm) ?? 0) + 1;
      calls.set(slot.arm, count);
      const messages = body.messages as any[],
        feedback = [...messages].reverse().find(message => message.role === 'tool');
      const args = count === 1 ? greetingSubmission(slot.arm, true) : {
        submission: {
          mode: 'repair',
          draftRevision: JSON.parse(feedback.content).draftRevision,
          patches: [{ op: 'add', path: '/title', value: '离线问候' }]
        }
      };
      return {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: slot.arm + '-' + count,
              type: 'function',
              function: { name: 'structured_output', arguments: JSON.stringify(args) }
            }
          ]
        },
        usage: null
      };
    }
  };
  const frozen = freezePair({
    repeats: 1,
    model: {
      provider: 'offline-fixture',
      model: 'not-a-provider',
      reasoningEffort: 'high',
      temperature: 0.2,
      maxOutputTokens: 8192
    },
    limits: { maxModelRequests: 3, maxSubmissions: 3, maxCatalogCalls: 3 },
    cases: [
      {
        id: item.id,
        instruction: item.instruction,
        context: contextFor(item),
        samples: item.samples
      }
    ],
    implementationHashes: {}
  });
  const result = await runPaired(frozen, provider, (flow, test) => oracle(flow, {
    id: test.id,
    instruction: test.instruction,
    samples: test.samples
  }));
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every(row =>
    row.status === 'success'
      && row.submissions === 2
      && row.feedback.length === 1
      && row.usage.unknownCalls === 2
  ));
  assert.ok(result.results.every(row =>
    row.timing.modelGenerationMs === null
      && row.timing.sdkStartupMs === null
      && row.calls.every(call =>
        call.providerRequestMs === null
          && call.providerFirstDeltaMs === null
      )
  ));
  return {
    passed: true,
    scope: 'Scripted responses compile and repair both authoring modes, then execute the same deterministic Graphon samples. Not provider, token accounting or design-speed measurements.',
    externalModelCalls: 0,
    arms: result.results.map(row => ({
      arm: row.arm,
      status: row.status,
      submissions: row.submissions,
      repairFeedback: row.feedback.length,
      samples: item.samples.length,
      providerUsage: null
    })),
    providerTimingsUnobservable: true
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await pairedSelfTest(), null, 2));

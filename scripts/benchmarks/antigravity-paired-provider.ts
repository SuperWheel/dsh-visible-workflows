/** Opt-in agent CLI transport. No credentials, automatic approval or real calls on import. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { slotKey, type PairProvider, type ProviderResponse, type Slot } from './template-fill-paired.ts';

export const defaultGeminiModel = 'gemini-3.8-flash-high';
export const defaultAgyExecutable = `${process.env.HOME}/.local/bin/agy`;
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: any): value is number => Number.isSafeInteger(value) && value >= 0;
const invalid = (reason: string): ProviderResponse => ({ error: `Antigravity harness-invalid: ${reason}`, harnessInvalid: true });

export function agyVersion(executable = defaultAgyExecutable): string {
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  return version;
}

/** Native JSONUsage excludes cache reads from total_tokens; retain raw receipt too. */
export function agyUsage(value: unknown): Record<string, unknown> | null {
  if (!object(value)) return null;
  const { input_tokens: input, output_tokens: output, cache_read_tokens: cache, total_tokens: total } = value;
  if (![input, output, cache, total].every(count) || total !== input + output || !count(total + cache)) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cache, total_tokens: total + cache,
    agyRaw: { input_tokens: input, output_tokens: output, cache_read_tokens: cache, total_tokens: total } };
}

// agy exposes its full agent toolset and offers no switch to disable it; in 1.4.5 the model
// otherwise starts with `ls`. The same note precedes every turn of both arms.
const HARNESS_NOTE = '[HARNESS NOTE] Answer only from the messages below. Do not call any tool, run commands, read or list files, browse, or ask for permission; return the final JSON matching the schema directly.';
const delimited = (messages: Record<string, any>[]) => [HARNESS_NOTE, ...messages.map(message =>
  `[BEGIN ${message.role === 'tool' ? 'COMPILER FEEDBACK' : String(message.role).toUpperCase()} MESSAGE]\n${JSON.stringify(message.content)}\n[END MESSAGE]`)].join('\n');

export class AntigravityPairProvider implements PairProvider {
  private attempt?: { key: string; cwd: string; conversation?: string; sent: number; broken: boolean };
  private child?: ChildProcess;
  private busy = false;
  private closed = false;
  constructor(private readonly options: { executable?: string; model?: string; effort?: string; timeoutMs?: number; temporaryRoot?: string } = {}) {}

  async request(body: Record<string, unknown>, slot: Slot): Promise<ProviderResponse> {
    assert.ok(!this.busy, 'Serial requests only');
    if (this.closed) return invalid('provider is closed');
    const key = slotKey(slot), messages = body.messages as Record<string, any>[];
    const submission = (body.tools as any[])?.find(tool => tool?.function?.name === 'structured_output');
    if (!submission?.function?.parameters || !Array.isArray(messages)) return invalid('missing submission schema/messages');
    if (!this.attempt || this.attempt.key !== key) {
      this.disposeAttempt();
      this.attempt = { key, cwd: mkdtempSync(join(this.options.temporaryRoot ?? tmpdir(), 'paired-agy-')), sent: 0, broken: false };
    }
    const attempt = this.attempt;
    // Cold public-transcript recovery cannot establish the original agy conversation.
    if (attempt.broken || (!attempt.conversation && (messages.length !== 2 || messages.some(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      try { return JSON.parse(message.content)?.resumeProtocol === 'public-transcript-v1'; } catch { return false; }
    })))) return invalid('conversation continuity unavailable; unfinished attempt cannot be restarted');
    const fresh = messages.slice(attempt.sent);
    if (!fresh.length || fresh.some(message => !['system', 'user', 'tool', 'assistant'].includes(message.role))) return invalid('invalid continuation messages');
    const feedback = attempt.conversation ? fresh.filter(message => message.role !== 'assistant') : fresh;
    if (!feedback.length || (attempt.conversation && feedback.some(message => !['user', 'tool'].includes(message.role)))) return invalid('continuation must contain only new feedback');
    const timeoutMs = this.options.timeoutMs ?? 240000;
    // agy 1.4.5 rejects --effort with a tiered model id (gemini-*-high); the tier is the effort.
    const model = this.options.model ?? defaultGeminiModel, tier = /-(low|medium|high)$/.exec(model)?.[1];
    if (tier && this.options.effort && this.options.effort !== tier) return invalid(`model tier ${tier} differs from configured effort`);
    // --mode plan is ignored with slash commands disabled; isolation is sandbox + empty cwd + no approval.
    const argv = ['--model', model, ...(tier ? [] : ['--effort', this.options.effort ?? 'max']),
      '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands',
      '--print-timeout', `${timeoutMs}ms`, '--json-schema', JSON.stringify(submission.function.parameters),
      ...(attempt.conversation ? ['--conversation', attempt.conversation] : []), '--print', delimited(feedback)];
    if (body.model !== (this.options.model ?? defaultGeminiModel)) return invalid('request model differs from configured model');
    this.busy = true;
    const started = performance.now();
    try {
      return await new Promise<ProviderResponse>(resolve => {
        let first: number | null = null, validText: number | null = null, result: Record<string, any> | undefined;
        let failure: ProviderResponse | undefined, bytes = 0, seenInit = false;
        const usages = new Map<number, Record<string, unknown> | null>();
        const child = spawn(this.options.executable ?? defaultAgyExecutable, argv, {
          cwd: attempt.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        this.child = child;
        const stop = (response: ProviderResponse) => { failure ??= response; this.kill(); };
        const timer = setTimeout(() => stop({ error: 'Antigravity print deadline exceeded', timedOut: true }), timeoutMs);
        const identify = (id: unknown) => {
          if (typeof id !== 'string' || !/^[\w-]{1,256}$/.test(id) || (attempt.conversation && id !== attempt.conversation)) throw Error('conversation identity missing or changed');
          attempt.conversation = id;
        };
        const lines = createInterface({ input: child.stdout });
        lines.on('line', line => {
          // Local diagnosis only: raw events go to an explicit directory, never to logs.
          if (process.env.PAIRED_AGY_RAW_DIR) appendFileSync(join(process.env.PAIRED_AGY_RAW_DIR, `${key.replace(/[^\w.-]/g, '_')}.jsonl`), line + '\n');
          if (failure) return;
          try {
            if (!line.trim()) return;
            const event = JSON.parse(line);
            if (!object(event) || typeof event.event !== 'string') throw Error('unknown stream envelope');
            if (result) throw Error('event after final result');
            // Inspect metadata only: user/model text may contain these words harmlessly.
            if (/permission|approval|tool/i.test(event.event) || event.permission_request || event.tool_calls?.length) throw Error('agent invoked a tool or requested permission');
            if (event.event === 'init') {
              if (seenInit || event.init?.model !== (this.options.model ?? defaultGeminiModel)) throw Error('initial model identity missing or changed');
              seenInit = true; identify(event.conversation_id);
            } else if (event.event === 'step_update') {
              const step = event.step_update;
              if (!seenInit || !object(step)) throw Error('step without initialization');
              // With --json-schema, 1.4.5 delivers the structured answer through its own `finish` tool;
              // it touches no files. An ERROR finish is agy rejecting the output, settled by the final result.
              const finishing = step.step_type === 'tool' && step.tool_name === 'finish' && step.tool_info?.name === 'finish' && !step.permission_request;
              if (!finishing && (step.step_type === 'tool' || step.tool_info || step.tool_name || step.permission_request || /permission|approval/i.test(String(step.state)))) throw Error('agent invoked a tool or requested permission');
              // Observed in 1.4.5: an untyped bookkeeping step and a finish step, both without tool fields.
              if (!finishing && !['user_input', 'agent_response', 'checkpoint', 'unknown', 'finish'].includes(step.step_type)) throw Error('unrecognized agent step');
              if (!finishing && (step.error || step.is_error || (step.state !== undefined && !['PENDING', 'QUEUED', 'ACTIVE', 'RUNNING', 'IN_PROGRESS', 'DONE'].includes(step.state)))) throw Error('agent step failed or has an unknown state');
              if (step.conversation_id !== undefined) identify(step.conversation_id);
              if (step.step_type === 'agent_response') {
                if (typeof step.text_delta === 'string' && step.text_delta.length) {
                  first ??= performance.now() - started;
                  validText ??= first;
                }
                if (step.state === 'DONE') {
                  if (!count(step.step_index)) throw Error('missing response step index');
                  usages.set(step.step_index, agyUsage(step.usage));
                }
              }
            } else if (event.event === 'result') {
              if (!seenInit && object(event.result) && event.result.status === 'ERROR') throw Error(`CLI error before start: ${String(event.result.error ?? '').slice(0, 300)}`);
              if (!seenInit || !object(event.result)) throw Error('final result without initialization');
              result = event.result; identify(result.conversation_id);
              if (result.status !== 'SUCCESS' || result.is_error || result.error) throw Error('CLI did not report a successful final result');
              if (typeof result.response !== 'string' && !object(result.structured_output)) throw Error('missing structured final output');
              first ??= performance.now() - started;
            } else throw Error('unrecognized stream event; tool isolation cannot be verified');
          } catch (error) { stop(invalid(error instanceof SyntaxError ? 'invalid stream JSON' : error instanceof Error ? error.message : 'invalid stream')); }
        });
        // Scan, but never persist/log, stderr: permission prompts may be emitted here.
        let stderrTail = '';
        child.stderr.on('data', chunk => {
          stderrTail = (stderrTail + chunk.toString()).slice(-8192);
          if (/permission[ _-]*request|approval[ _-]*request|approve[^\n]*tool/i.test(stderrTail)) stop(invalid('agent requested permission on stderr'));
        });
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop(invalid('stream exceeded 8 MiB')); });
        child.on('error', () => { failure ??= invalid('CLI could not start'); });
        child.on('close', code => {
          clearTimeout(timer); lines.close(); this.child = undefined;
          const requestMs = performance.now() - started;
          if (!failure && (code !== 0 || !result)) failure = invalid('CLI exited without a valid final result');
          if (failure) { attempt.broken = true; resolve({ ...failure, usage: null, firstDeltaMs: first, requestMs }); return; }
          const receipts = [...usages.values()];
          let usage = agyUsage(result!.usage);
          if (!usage && receipts.length && receipts.every(value => value !== null)) {
            const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'total_tokens'];
            const totals = Object.fromEntries(fields.map(field => [field, receipts.reduce((sum, value) => sum + (value![field] as number), 0)]));
            if (Object.values(totals).every(count)) usage = { ...totals, agyRaw: receipts.map(value => value!.agyRaw) };
          }
          attempt.sent = messages.length;
          resolve({ message: { role: 'assistant', tool_calls: [{ id: `agy-${attempt.sent}`, function: {
            name: 'structured_output', arguments: object(result!.structured_output) ? JSON.stringify(result!.structured_output) : result!.response
          } }] }, usage, firstDeltaMs: first, firstValidTextMs: validText, requestMs });
        });
      });
    } finally { this.busy = false; }
  }
  private kill() {
    if (!this.child?.pid) return;
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
  }
  private disposeAttempt() {
    if (this.attempt) rmSync(this.attempt.cwd, { recursive: true, force: true });
    this.attempt = undefined;
  }
  close() { this.closed = true; this.kill(); this.disposeAttempt(); }
}

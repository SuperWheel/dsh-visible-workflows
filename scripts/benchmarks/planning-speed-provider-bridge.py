"""Private S10 pipe transport. Credentials/reasoning never enter artifact files or logs."""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
key = None

for line in sys.stdin:
    started = time.monotonic()
    usage, observed, valid_text, valid_args = None, None, None, None
    try:
        body = json.loads(line)
        if (body.get('model') != 'glm-5.3-flash' or body.get('reasoning_effort') != 'max'
                or body.get('max_tokens') != 8192 or body.get('temperature') != 0.2):
            raise ValueError('Frozen model controls changed')
        # Resolve only in this private process, after a valid explicit run request.
        if key is None:
            key = os.environ.get('ZAI_CODING_CN_API_KEY')
            if not key:
                import yaml
                with open(os.path.expanduser('~/.dsh/.credentials.yaml')) as source:
                    key = yaml.safe_load(source)['refs']['ZAI_CODING_CN_API_KEY']
        body['stream'] = True
        body['stream_options'] = {'include_usage': True}
        request = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        content, reasoning, calls, finish = '', '', {}, None
        with urllib.request.urlopen(request, timeout=180) as response:
            for raw in response:
                if time.monotonic() - started > 240:
                    raise TimeoutError('Private request deadline')
                if not raw.startswith(b'data: '):
                    continue
                payload = raw[6:].strip()
                if payload == b'[DONE]':
                    break
                data = json.loads(payload)
                if data.get('usage') is not None:
                    usage = data['usage']
                for choice in data.get('choices', []):
                    delta = choice.get('delta', {})
                    elapsed = (time.monotonic() - started) * 1000
                    if observed is None and delta:
                        observed = elapsed
                    text = delta.get('content') or ''
                    if valid_text is None and isinstance(text, str) and text.strip():
                        valid_text = elapsed
                    content += text
                    reasoning += delta.get('reasoning_content') or ''
                    for call in delta.get('tool_calls', []):
                        function = call.get('function', {})
                        fragment = function.get('arguments') or ''
                        if valid_args is None and isinstance(fragment, str) and fragment.strip():
                            valid_args = elapsed
                        target = calls.setdefault(call['index'], {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                        target['id'] += call.get('id') or ''
                        for field in ['name', 'arguments']:
                            target['function'][field] += function.get(field) or ''
                    finish = choice.get('finish_reason') or finish
        message = {'role': 'assistant', 'content': content or None}
        if reasoning:
            message['reasoning_content'] = reasoning  # Required replay only; memory/pipe, never a public journal.
        if calls:
            message['tool_calls'] = [calls[index] for index in sorted(calls)]
        result = {'message': message, 'finish': finish}
    except Exception as error:
        # Do not echo provider bodies, headers, prompts, credentials or exception messages.
        result = {'error': type(error).__name__, 'status': getattr(error, 'code', None)}
    result.update({'usage': usage, 'firstDeltaMs': observed, 'firstValidTextMs': valid_text,
                   'firstValidToolArgumentsMs': valid_args, 'requestMs': (time.monotonic() - started) * 1000})
    print(json.dumps(result), flush=True)

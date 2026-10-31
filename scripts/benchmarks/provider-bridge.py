"""Private pipe transport for the opt-in compiler benchmark. Never logs credentials or reasoning."""
import json, sys, time, urllib.request, urllib.error, os
import yaml

key = os.environ.get('ZAI_CODING_CN_API_KEY')
if not key:
    with open(os.path.expanduser('~/.dsh/.credentials.yaml')) as source:
        key = yaml.safe_load(source)['refs']['ZAI_CODING_CN_API_KEY']
endpoint = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
for line in sys.stdin:
    try:
        body = json.loads(line)
        if body.get('model') != 'glm-5.3-flash':
            raise ValueError('Benchmark model is frozen')
        body['stream'] = True
        body['stream_options'] = {'include_usage': True}
        start = time.monotonic()
        request = urllib.request.Request(endpoint, data=json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        content, reasoning, calls, usage, first, finish = '', '', {}, None, None, None
        with urllib.request.urlopen(request, timeout=180) as response:
            for raw in response:
                if time.monotonic() - start > 240:
                    raise TimeoutError('request deadline')
                if not raw.startswith(b'data: '):
                    continue
                payload = raw[6:].strip()
                if payload == b'[DONE]':
                    break
                data = json.loads(payload)
                if data.get('usage'):
                    usage = data['usage']
                for choice in data.get('choices', []):
                    delta = choice.get('delta', {})
                    if first is None and delta:
                        first = (time.monotonic() - start) * 1000
                    content += delta.get('content') or ''
                    reasoning += delta.get('reasoning_content') or ''
                    for call in delta.get('tool_calls', []):
                        target = calls.setdefault(call['index'], {'id': '', 'type': 'function', 'function': {'name': '', 'arguments': ''}})
                        target['id'] += call.get('id') or ''
                        for field in ['name', 'arguments']:
                            target['function'][field] += call.get('function', {}).get(field) or ''
                    finish = choice.get('finish_reason') or finish
        message = {'role': 'assistant', 'content': content or None}
        if reasoning:
            message['reasoning_content'] = reasoning  # Memory-only round-trip required by the provider.
        if calls:
            message['tool_calls'] = [calls[i] for i in sorted(calls)]
        print(json.dumps({'message': message, 'usage': usage, 'firstDeltaMs': first,
                          'requestMs': (time.monotonic() - start) * 1000, 'finish': finish}), flush=True)
    except Exception as error:
        # Do not include headers, request contents, credential values or raw provider error bodies.
        print(json.dumps({'error': type(error).__name__, 'status': getattr(error, 'code', None)}), flush=True)

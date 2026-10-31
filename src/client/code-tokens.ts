export type CodeLanguage = 'json' | 'javascript' | 'python' | 'template' | 'text'
export type CodeTokenKind = 'plain' | 'string' | 'property' | 'number' | 'keyword' | 'comment' | 'punctuation' | 'variable'
export interface CodeToken { text: string; kind: CodeTokenKind }

/** Syntax colours are a reading aid only. This bounded scanner never evaluates code or produces HTML. */
export function tokenizeCode(value: string, language: CodeLanguage): CodeToken[] {
  if (language === 'text' || value.length > 60_000) return [{ text: value, kind: 'plain' }]
  const tokens: CodeToken[] = []
  const append = (text: string, kind: CodeTokenKind) => {
    if (!text) return
    const previous = tokens[tokens.length - 1]
    if (previous?.kind === kind) previous.text += text
    else tokens.push({ text, kind })
  }
  let position = 0
  while (position < value.length) {
    if (tokens.length >= 8_000) { append(value.slice(position), 'plain'); break }
    const start = position, character = value[position]!
    if (value.startsWith('{{', position)) {
      const end = value.indexOf('}}', position + 2)
      if (end !== -1) { position = end + 2; append(value.slice(start, position), 'variable'); continue }
    }
    if (language === 'template') { position++; append(character, 'plain'); continue }
    if ((language === 'python' && character === '#') || (language === 'javascript' && value.startsWith('//', position))) {
      const end = value.indexOf('\n', position)
      position = end === -1 ? value.length : end
      append(value.slice(start, position), 'comment'); continue
    }
    if (language === 'javascript' && value.startsWith('/*', position)) {
      const end = value.indexOf('*/', position + 2)
      position = end === -1 ? value.length : end + 2
      append(value.slice(start, position), 'comment'); continue
    }
    if (character === '"' || (language !== 'json' && (character === "'" || character === '`'))) {
      const quote = language === 'python' && value.startsWith(character.repeat(3), position) ? character.repeat(3) : character
      position += quote.length
      while (position < value.length) {
        if (value[position] === '\\') { position = Math.min(value.length, position + 2); continue }
        if (value.startsWith(quote, position)) { position += quote.length; break }
        position++
      }
      let next = position
      while (next < value.length && /\s/.test(value[next]!)) next++
      append(value.slice(start, position), value[next] === ':' ? 'property' : 'string'); continue
    }
    if (/[\d]/.test(character) || (character === '-' && /\d/.test(value[position + 1] || ''))) {
      const number = value.slice(position).match(/^-?(?:0x[\da-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/)?.[0]
      if (number) { position += number.length; append(number, 'number'); continue }
    }
    if (/[a-zA-Z_$]/.test(character)) {
      position++
      while (position < value.length && /[a-zA-Z\d_$]/.test(value[position]!)) position++
      const word = value.slice(start, position)
      const keyword = language === 'json' ? /^(true|false|null)$/ : language === 'python'
        ? /^(def|return|if|elif|else|for|while|in|import|from|as|class|try|except|finally|raise|with|yield|lambda|and|or|not|is|None|True|False|pass|break|continue|async|await)$/
        : /^(function|return|const|let|var|if|else|for|while|of|in|class|new|try|catch|finally|throw|async|await|true|false|null|undefined|typeof|export|default|import|from|switch|case|break|continue)$/
      append(word, keyword.test(word) ? 'keyword' : 'plain'); continue
    }
    position++
    append(character, /[{}[\]():,;]/.test(character) ? 'punctuation' : 'plain')
  }
  return tokens
}

export function formatJsonCode(value: string): { value: string; error?: undefined } | { value: string; error: string } {
  try { return { value: JSON.stringify(JSON.parse(value), null, 2) } }
  catch { return { value, error: 'JSON 格式不完整，已保留原文。请检查引号、逗号和括号。' } }
}

export interface CodeSelection { value: string; start: number; end: number }
/** Keep native cursor offsets when indenting or outdenting a selected set of lines. */
export function indentCode(value: string, start: number, end: number, outdent = false): CodeSelection {
  if (!outdent && start === end) return { value: value.slice(0, start) + '  ' + value.slice(end), start: start + 2, end: start + 2 }
  const first = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  const segmentEnd = value.indexOf('\n', last)
  const until = segmentEnd === -1 ? value.length : segmentEnd
  const lines = value.slice(first, until).split('\n')
  let offset = first, startDelta = 0, endDelta = 0
  const changed = lines.map(line => {
    const removed = outdent ? (line.startsWith('\t') ? 1 : Math.min(2, line.match(/^ */)![0].length)) : 0
    const amount = outdent ? -removed : 2
    if (offset <= start) startDelta += outdent ? -Math.min(removed, Math.max(0, start - offset)) : 2
    if (offset < end || start === end) endDelta += outdent ? -Math.min(removed, Math.max(0, end - offset)) : 2
    offset += line.length + 1
    return outdent ? line.slice(removed) : '  ' + line
  }).join('\n')
  return { value: value.slice(0, first) + changed + value.slice(until), start: Math.max(first, start + startDelta), end: Math.max(first, end + endDelta) }
}

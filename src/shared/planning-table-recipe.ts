// Shared immutable v1 renderer; whole-graph and fragment digests are independent.
export const renderCode=String.raw`function main(inputs) {
  const specification = inputs.specification;
  const rows = typeof inputs.rows === 'string' ? JSON.parse(inputs.rows) : inputs.rows;
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('rows must be an array of at most 500 objects');
  const cell = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '&#92;').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
  const lines = ['# ' + cell(specification.title), ''];
  if (!rows.length) return {text:lines.concat(cell(specification.emptyText)).join('\n'),count:0};
  lines.push('| ' + specification.columns.map(column => cell(column.label)).join(' | ') + ' |');
  lines.push('| ' + specification.columns.map(() => '---').join(' | ') + ' |');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('each row must be an object');
    const values = specification.columns.map(column => {
      if (!Object.prototype.hasOwnProperty.call(row,column.key)) throw new Error('missing column ' + column.key);
      const value = row[column.key];
      if (value !== null && !['string','number','boolean'].includes(typeof value)) throw new Error('table cells must be scalar JSON values');
      return cell(value);
    });
    lines.push('| ' + values.join(' | ') + ' |');
  }
  return {text:lines.join('\n'),count:rows.length};
}`
export const inputContract={rows:{type:'array',maxItems:500,items:{type:'object',additionalProperties:{type:['string','number','boolean','null']}}}}
export const outputContract={text:{type:'string'},count:{type:'number'}}
export const fixedInput={fields:[{name:'rows',label:'数据行（JSON 数组）',required:true,type:'json'}]}
export const fixedCode={language:'javascript',code:renderCode,outputSchema:[{name:'text',type:'string',required:true},{name:'count',type:'number',required:true}],timeoutMs:1500}

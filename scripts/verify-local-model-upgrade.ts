import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { OllamaTechLeadModel } from '@repolead/lead-analyzer';

if (!process.argv.includes('--real')) { throw new Error('Use --real to run the installed local model.'); }
const model = await OllamaTechLeadModel.connect();
const source = 'export function format(value: number): string { return String(value); }';
const schema = { type: 'object', properties: {
  inputType: { type: 'string' }, outputType: { type: 'string' }, usesStringConversion: { type: 'boolean' },
  performsNetworkIO: { type: 'boolean' }, resultFor42: { type: 'string' },
}, required: ['inputType', 'outputType', 'usesStringConversion', 'performsNetworkIO', 'resultFor42'], additionalProperties: false };
const result = await model.complete({ system: 'Describe only behavior supported by the supplied TypeScript source. Return the required JSON.',
  prompt: `Inspect this complete function:\n${source}\nState its input/output types, conversion, network effects and result for 42.`, schema });
const expected = { inputType: 'number', outputType: 'string', usesStringConversion: true, performsNetworkIO: false, resultFor42: '42' };
const passed = JSON.stringify(Object.entries(result.json as object).sort()) === JSON.stringify(Object.entries(expected).sort());
writeFileSync('benchmarks/local-model-upgrade.json', JSON.stringify({ generatedAt: new Date().toISOString(), model: model.name,
  source, expected, passed, ...result,
  limits: 'One complete scalar-conversion function through the actual RepoLead Ollama adapter; validates runtime/JSON and prescribed facts, not broad generative quality or a filled 120K local context.' }, null, 2) + '\n');
assert.ok(passed, 'Local model must preserve the supplied function behavior.');
console.log(JSON.stringify({ passed, model: model.name, inputTokens: result.inputTokens, outputTokens: result.outputTokens, telemetry: result.telemetry }));

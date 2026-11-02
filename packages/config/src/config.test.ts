import { expect, test } from '@rstest/core';

import { analysisBudget, parseConfig } from './index';

test('configuration defaults and explicit CLI budget precedence', () => {
  const config = parseConfig('');
  expect(config.model.backend).toBe('ollama');
  expect(config.analysis_mode).toBe('files');
  expect(config.analysis_budget.file_pack_bytes).toBe(24000);
  expect(parseConfig('analysis_mode: symbols').analysis_mode).toBe('symbols');
  expect(config.analysis_budget.max_tokens).toBe(120000);
  expect(analysisBudget(config).batchSize).toBe(1);
  expect(analysisBudget(config, undefined, 4).batchSize).toBe(4);
  expect(analysisBudget(parseConfig('analysis_budget:\n  batch_size: 3')).batchSize).toBe(3);
  expect(config.analysis_budget.max_source_lines_per_pack).toBe(100000);
  expect(analysisBudget(config).maxReanalysisDepth).toBe(3);
  expect(analysisBudget(parseConfig('analysis_budget:\n  max_reanalysis_depth: 0')).maxReanalysisDepth).toBe(0);
  expect(analysisBudget(parseConfig('analysis_budget:\n  max_reanalysis_depth: 32')).maxReanalysisDepth).toBe(32);
  const custom = parseConfig('analysis_budget:\n  max_tokens: 8000\n  max_source_lines_per_pack: 500\nmodel:\n  backend: claude-code\n  name: selected-model\n');
  expect(analysisBudget(custom).maxTokens).toBe(8000);
  expect(analysisBudget(custom, 6000).maxTokens).toBe(6000);
  expect(analysisBudget(custom).maxSourceLinesPerPack).toBe(500);
  expect(custom.model.name).toBe('selected-model');
});

test('rejects unknown keys, unsafe module paths, duplicate names and invalid budgets', () => {
  for (const yaml of [
    'analysis_budget:\n  max_tokens: 0',
    'analysis_budget:\n  max_tokens: 120001',
    'analysis_budget:\n  batch_size: 0',
    'analysis_budget:\n  batch_size: 5',
    'analysis_budget:\n  batch_size: 1.5',
    'analysis_budget:\n  max_source_lines_per_pack: -1',
    'analysis_budget:\n  max_reanalysis_depth: -1',
    'analysis_budget:\n  max_reanalysis_depth: 33',
    'analysis_budget:\n  max_reanalysis_depth: 1.5',
    'analysis_budget:\n  max_tokens: 4000\n  max_tokens: 8000',
    'models: {}',
    'modules:\n  - name: external\n    path: ../outside',
    'modules:\n  - name: external\n    path: /outside',
    'modules:\n  - name: external\n    path: C:\\outside',
    'modules:\n  - name: same\n    path: src/a\n  - name: same\n    path: src/b',
    'modules:\n  - name: first\n    path: src/a\n  - name: second\n    path: src/a/',
  ]) { expect(() => parseConfig(yaml)).toThrow(); }
});

test('normalized declaration order is stable and module ownership supports nested paths', () => {
  const config = parseConfig('modules:\n  - name: nested\n    path: src/domain/core/\n  - name: domain\n    path: ./src/domain\n');
  expect(config.modules).toEqual([{ name: 'domain', path: 'src/domain' }, { name: 'nested', path: 'src/domain/core' }]);
});

test('external quality tools are opt-in and configuration rejects unknown tools/escaping coverage paths', () => {
  expect(parseConfig('').metrics).toEqual({ tools: [] });
  expect(parseConfig('metrics:\n  tools: [ruff, radon, ruff, jscpd]\n  coverage: coverage/lcov.info').metrics)
    .toEqual({ tools: ['jscpd', 'radon', 'ruff'], coverage: 'coverage/lcov.info' });
  expect(() => parseConfig('metrics:\n  tools: [madeup]')).toThrow();
  expect(() => parseConfig('metrics:\n  coverage: ../external')).toThrow();
});

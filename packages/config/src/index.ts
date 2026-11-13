import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { contentHash, DEFAULT_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS, DEFAULT_SOURCE_LINES, DEFAULT_LOCAL_MODEL } from '@repolead/domain';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const tokenCount = z.number().int().min(256).max(MAX_CONTEXT_TOKENS);
const modulePath = z.string().min(1).transform((path) => {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
})
  .refine((path) => !path.startsWith('/') && path !== '..' && !path.startsWith('../') && !/^[A-Za-z]:/.test(path),
    'Module paths must stay inside the repository.');

const configSchema = z.strictObject({
  version: z.literal(1).default(1),
  modules: z.array(z.strictObject({ name: z.string().min(1), path: modulePath, critical: z.boolean().optional() })).default([]),
  documentation: z.strictObject({
    paths: z.array(modulePath).default(['README.md', 'docs']),
  }).prefault({}),
  metrics: z.strictObject({
    tools: z.array(z.enum(['jscpd', 'ruff', 'radon'])).default([]).transform((tools) => [...new Set(tools)].sort()),
    coverage: modulePath.optional(),
  }).prefault({}),
  analysis_budget: z.strictObject({
    file_pack_bytes: z.number().int().min(4096).max(100000).default(24000),
    batch_size: z.number().int().min(1).max(4).default(1),
    max_tokens: tokenCount.default(DEFAULT_CONTEXT_TOKENS),
    max_symbols_per_pack: z.number().int().positive().optional(),
    max_edges_per_pack: z.number().int().nonnegative().optional(),
    max_source_lines_per_pack: z.number().int().positive().max(100000).default(DEFAULT_SOURCE_LINES),
    max_findings_per_module: z.number().int().positive().default(20),
    max_evidence_per_finding: z.number().int().positive().default(8),
    max_reanalysis_depth: z.number().int().min(0).max(32).default(3),
  }).prefault({}),
  symbol_selection: z.enum(['all', 'public-or-nontrivial']).default('all'),
  analysis_mode: z.enum(['entrypoints', 'files', 'symbols']).default('files'),
  local_model: z.strictObject({
    url: z.url().default('http://127.0.0.1:11434'),
    model: z.string().min(1).default(DEFAULT_LOCAL_MODEL),
    digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    context: z.number().int().min(4096).max(262144).default(131072),
    output: z.number().int().min(256).max(16000).default(4096),
    timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  }).optional(),
  model: z.strictObject({
    backend: z.enum(['ollama', 'api', 'claude-code']).default('ollama'),
    name: z.string().min(1).optional(),
  }).prefault({}),
});

export type RepoLeadConfig = z.infer<typeof configSchema>;

export function parseConfig(source: string): RepoLeadConfig {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) { throw new Error(`Invalid .repolead.yaml: ${document.errors[0]!.message}`); }
  const config = configSchema.parse(document.toJS({ maxAliasCount: 50 }) ?? {});
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const module of config.modules) {
    if (names.has(module.name) || paths.has(module.path)) { throw new Error('Duplicate module name or normalized path in .repolead.yaml.'); }
    names.add(module.name);
    paths.add(module.path);
  }
  // Module declaration order must not invalidate a repository or affect ownership.
  config.modules.sort((left, right) => left.path.localeCompare(right.path));
  return config;
}

export function loadConfig(rootPath: string): { config: RepoLeadConfig; fingerprint: string; path: string | null } {
  const path = join(rootPath, '.repolead.yaml');
  const present = existsSync(path);
  const config = parseConfig(present ? readFileSync(path, 'utf8') : '');
  return { config, fingerprint: contentHash(JSON.stringify(config)), path: present ? path : null };
}

export function analysisBudget(config: RepoLeadConfig, explicitTokens?: number, explicitBatchSize?: number) {
  return {
    filePackBytes: config.analysis_budget.file_pack_bytes,
    batchSize: z.number().int().min(1).max(4).parse(explicitBatchSize ?? config.analysis_budget.batch_size),
    maxTokens: explicitTokens === undefined ? config.analysis_budget.max_tokens : tokenCount.parse(explicitTokens),
    maxSymbolsPerPack: config.analysis_budget.max_symbols_per_pack,
    maxEdgesPerPack: config.analysis_budget.max_edges_per_pack,
    maxSourceLinesPerPack: config.analysis_budget.max_source_lines_per_pack,
    maxReanalysisDepth: config.analysis_budget.max_reanalysis_depth,
  };
}

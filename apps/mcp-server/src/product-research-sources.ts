import { posix } from 'node:path';
import { contentHash, DEPENDENCY_EDGE_TYPES } from '@repolead/domain';
import { countTokens } from '@repolead/retrieval';
import type { ProductView } from './product';

export interface ResearchSource {
  ref: string;
  path: string;
  kind: string;
  hash: string;
  lines: number;
  reason: string;
  text: string;
}
export interface ResearchSources {
  sources: ResearchSource[];
  omitted: { path: string; reason: string; ref?: string }[];
  unresolvedGraphTargets: number;
  redactions: number;
  tokens: number;
  forbiddenValues: string[];
}
const words = (text: string) => [...new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((word) => word.length > 2);
const supported = (path: string) => /\.(?:py|[cm]?[jt]sx?)$/.test(path) && !/(?:^|\/)(?:tests?|__tests__|node_modules|vendor|\.venv|migrations)(?:\/|$)|\.(?:test|spec)\./i.test(path);
const kind = (path: string) => /(?:guard|validat)/i.test(path) ? 'validation'
  : /(?:dto|schema|fields|limits)/i.test(path) ? 'data-contract'
  : /(?:^|\/)ports\//.test(path) ? 'port'
  : /(?:model|entit)/i.test(path) ? 'data-model'
  : /repositor/i.test(path) ? 'persistence'
  : /(?:use_cases|usecases|use-cases)\//.test(path) ? 'usecase'
  : /(?:pages|screens)\//.test(path) ? 'page'
  : /components\//.test(path) ? 'component' : 'related-code';

function importedPaths(path: string, text: string, paths: Set<string>): string[] {
  const candidates = new Set<string>();
  const add = (base: string) => {
    for (const suffix of ['', '.py', '/__init__.py', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const candidate = posix.normalize(base + suffix);
      if (paths.has(candidate)) { candidates.add(candidate); }
    }
  };
  if (path.endsWith('.py')) {
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      const name = match[1] ?? match[2]!;
      const relative = /^\.+/.exec(name)?.[0].length ?? 0;
      add(relative ? posix.join(posix.dirname(path), ...Array<string>(relative - 1).fill('..'), name.slice(relative).replaceAll('.', '/')) : name.replaceAll('.', '/'));
    }
  } else {
    for (const match of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
      const name = match[1]!;
      if (name.startsWith('.')) { add(posix.join(posix.dirname(path), name)); }
      else if (/^[@~]\//.test(name)) { add(`src/${name.slice(2)}`); }
      else { add(name); }
    }
  }
  return [...candidates];
}

/** Research consumes immutable captured source, never arbitrary files or a later working tree. */
export function prepareResearchSources(view: ProductView, input: {
  question: string; queries?: string[]; refs?: string[]; sourceRefs?: string[]; maxFiles?: number; depth?: number;
}): ResearchSources {
  const { repo, snapshot } = view;
  const files = repo.store.listFiles(snapshot.id).filter((file) => supported(file.path));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const paths = new Set(byPath.keys());
  const corpusWords = words([input.question, ...(input.queries ?? [])].join(' '));
  const selectedRefs = input.refs?.length ? input.refs : input.sourceRefs?.length ? [] : view.records.map((record) => ({ record,
    score: corpusWords.reduce((n, word) => n + (words(`${record.title} ${record.purpose ?? ''}`).includes(word) ? 1 : 0), 0),
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.record.ref);
  if (input.refs?.some((ref) => !view.records.some((record) => record.ref === ref))) { throw new Error('Referencia ajena o vencida. Vuelve a consultar product_context.'); }
  const roots = new Set<string>();
  const rootReasons = new Map<string, string>();
  for (const ref of input.sourceRefs ?? []) {
    const file = files.find((candidate) => `source:${contentHash(`${repo.name}\n${snapshot.id}\n${candidate.path}\n${candidate.contentHash}`)}` === ref);
    if (!file) { throw new Error('Referencia de fuente ajena o vencida. Repite la investigación sobre la publicación vigente.'); }
    roots.add(file.path);
    rootReasons.set(file.path, 'followed-source-reference');
  }
  for (const [subject, ref] of view.subjects) {
    if (!selectedRefs.includes(ref)) { continue; }
    const summary = repo.store.getSummary(snapshot.id, subject, 'file');
    if (summary) { for (const evidence of repo.store.getSummaryEvidence(summary.id)) { if (evidence.kind === 'source' && byPath.has(evidence.path)) { roots.add(evidence.path); rootReasons.set(evidence.path, 'selected-entrypoint'); } } }
  }
  const graph = repo.store.loadGraph(snapshot.id);
  if (!roots.size && !input.refs?.length && !input.sourceRefs?.length) {
    const names = new Map<string, string>();
    for (const symbol of graph.symbols.values()) { names.set(symbol.path, `${names.get(symbol.path) ?? ''} ${symbol.qualifiedName}`); }
    const ranked = files.map((file) => ({ path: file.path, score: corpusWords.reduce((score, word) => score
      + (words(`${posix.basename(file.path)} ${names.get(file.path) ?? ''}`).includes(word) ? 2 : words(file.path).includes(word) ? 1 : 0), 0) }))
      .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 3);
    for (const entry of ranked) { roots.add(entry.path); rootReasons.set(entry.path, 'indexed-source-discovery-no-summary'); }
  }
  if (!roots.size) { throw new Error('No se localizaron entradas con fuente capturada. Usa referencias de product_context o palabras clave del código en inglés.'); }
  const fileById = new Map(files.map((file) => [file.id, file.path]));
  const fileOf = (id: string) => fileById.get(id) ?? graph.symbols.get(id)?.path;
  const links = new Map<string, Set<string>>();
  let unresolvedGraphTargets = 0;
  const link = (from: string, to: string) => { if (from !== to && byPath.has(to)) { const set = links.get(from) ?? new Set<string>(); set.add(to); links.set(from, set); } };
  for (const edges of graph.outgoing.values()) {
    for (const edge of edges) {
      if (!DEPENDENCY_EDGE_TYPES.has(edge.edgeType) || edge.edgeType === 'TESTED_BY') { continue; }
      const from = fileOf(edge.sourceId); const to = fileOf(edge.targetId);
      if (from && to) { link(from, to); if (['IMPLEMENTS', 'EXTENDS'].includes(edge.edgeType)) { link(to, from); } }
      else if (from && roots.has(from)) { unresolvedGraphTargets++; }
    }
  }
  const queue = [...roots].map((path) => ({ path, distance: 0, reason: rootReasons.get(path)! }));
  const seen = new Set<string>();
  const result: ResearchSources = { sources: [], omitted: [], unresolvedGraphTargets, redactions: 0, tokens: 0, forbiddenValues: [] };
  let bytes = 0;
  const add = (path: string, distance: number, reason: string) => { if (!seen.has(path) && paths.has(path)) { queue.push({ path, distance, reason }); } };
  const rootWords = [...roots].flatMap((path) => words(posix.basename(path))).filter((word) => !['create', 'update', 'get', 'list', 'delete', 'use', 'case', 'usecase'].includes(word));
  const priority: Record<string, number> = { validation: 10, 'data-contract': 8, persistence: 6, 'data-model': 3 };
  const relevance = (path: string) => corpusWords.filter((word) => words(path).includes(word)).length
    + rootWords.filter((word) => words(posix.basename(path)).includes(word)).length * 6 + (priority[kind(path)] ?? 0);
  while (queue.length) {
    queue.sort((a, b) => a.distance - b.distance || relevance(b.path) - relevance(a.path) || a.path.localeCompare(b.path));
    const current = queue.shift()!;
    if (seen.has(current.path)) { continue; }
    seen.add(current.path);
    const file = byPath.get(current.path)!;
    const raw = repo.store.getSnapshotSource(snapshot.id, file.path);
    if (raw === null || contentHash(raw) !== file.contentHash) { result.omitted.push({ path: file.path, reason: 'missing-or-inconsistent-captured-source' }); continue; }
    // Preserve line numbers and remove likely credential literals before sending to the LOCAL model.
    const text = raw.replace(/(["']?(?:password|passwd|secret|api[_-]?key|(?:access|refresh|auth)[_-]?token)["']?\s*[:=]\s*)["']([^"'\r\n]{6,})["']/gi,
      (_whole: string, prefix: string, value: string) => { result.forbiddenValues.push(value); result.redactions++; return `${prefix}"[REDACTED]"`; })
      .replace(/-----BEGIN[^\r\n]*PRIVATE KEY-----[\s\S]*?-----END[^\r\n]*PRIVATE KEY-----/g, (value) => {
        result.forbiddenValues.push(value); result.redactions++; return value.split('\n').map(() => '[REDACTED]').join('\n');
      });
    const lines = text.split('\n');
    const numbered = lines.map((line, index) => `${index + 1}\t${line}`).join('\n');
    const cost = Buffer.byteLength(numbered, 'utf8');
    if (result.sources.length >= (input.maxFiles ?? 40) || bytes + cost > 90000 || result.tokens + countTokens(numbered) > MAX_RESEARCH_TOKENS) {
      result.omitted.push({ path: file.path, reason: 'whole-file-evidence-budget' }); continue;
    }
    result.sources.push({ ref: `source:${contentHash(`${repo.name}\n${snapshot.id}\n${file.path}\n${file.contentHash}`)}`,
      path: file.path, kind: kind(file.path), hash: file.contentHash, lines: lines.length, reason: current.reason, text: numbered });
    bytes += cost; result.tokens += countTokens(numbered);
    if (current.distance >= (input.depth ?? 3)) {
      for (const path of new Set([...(links.get(file.path) ?? []), ...importedPaths(file.path, text, paths)])) {
        if (!seen.has(path)) { result.omitted.push({ path, reason: 'dependency-depth-boundary' }); }
      }
      continue;
    }
    for (const path of importedPaths(file.path, text, paths)) { add(path, current.distance + 1, 'indexed-import'); }
    for (const path of links.get(file.path) ?? []) { add(path, current.distance + 1, 'indexed-graph'); }
    // Injection implementations are candidates, not proof of the runtime binding.
    // Keep the candidate at the port's distance so its models can fit within the next hop.
    if (kind(file.path) === 'port') {
      const base = posix.basename(file.path).replace(/\.[^.]+$/, '');
      for (const candidate of files) {
        if (/infrastructure|implementations/.test(candidate.path) && posix.basename(candidate.path).replace(/\.[^.]+$/, '') === `${base}_impl`) {
          add(candidate.path, current.distance, 'implementation-candidate-not-runtime-proof');
        }
      }
    }
  }
  const retained = new Set(result.sources.map((source) => source.path));
  result.omitted = [...new Map(result.omitted.filter((entry) => !retained.has(entry.path)).map((entry) => {
    const file = byPath.get(entry.path)!;
    return [`${entry.path}:${entry.reason}`, { ...entry, ref: `source:${contentHash(`${repo.name}\n${snapshot.id}\n${entry.path}\n${file.contentHash}`)}` }];
  })).values()];
  return result;
}

const MAX_RESEARCH_TOKENS = 120000;

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scanRepository } from '@repolead/code-graph';
import { contentHash, sliceSource } from '@repolead/domain';
import { openStore } from '@repolead/knowledge-store';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'repolead-deterministic-'));
const root = join(temp, 'fixture');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
try {
  mkdirSync(join(root, 'src'), { recursive: true });
  const names = Array.from({ length: 20 }, (_, index) => `compute${String(index).padStart(2, '0')}`);
  const definitions = names.map((name, index) => `export function ${name}(value: number): number { return value + ${index}; }`).join('\n');
  const callers = `import { ${names.join(', ')} } from './definitions';\n` + names.map((name, index) =>
    `export function caller${index}(value: number) { const label = "🧠á"; const callback = ${name}; return ${name}(value) + callback(value); }`).join('\n');
  writeFileSync(join(root, 'src/definitions.ts'), definitions);
  writeFileSync(join(root, 'src/callers.ts'), callers);
  writeFileSync(join(root, 'package.json'), '{"name":"scip-reference-acceptance"}');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true }, include: ['src'] }));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'RepoLead acceptance'); git(root, 'config', 'user.email', 'acceptance@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'Compiler reference fixture');
  const scanned = await scanRepository({ rootPath: root, dbPath: join(temp, 'references.db'), repositoryName: 'Compiler acceptance' });
  assert.ok(scanned.referencesResolved && scanned.referencesResolved >= 60);
  const store = await openStore(scanned.dbPath);
  const referenceChecks: Record<string, unknown>[] = [];
  try {
    const paths = [join(root, 'src/definitions.ts'), join(root, 'src/callers.ts')];
    const compilerOptions: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => paths,
      getScriptVersion: () => '1',
      getScriptSnapshot: (path) => existsSync(path) ? ts.ScriptSnapshot.fromString(readFileSync(path, 'utf8')) : undefined,
      getCurrentDirectory: () => root,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    };
    const languageService = ts.createLanguageService(host);
    try {
      assert.equal(languageService.getSyntacticDiagnostics(paths[0]!).length, 0);
      assert.equal(languageService.getSemanticDiagnostics(paths[1]!).length, 0);
      const graph = store.loadGraph(scanned.snapshotId);
      for (const [index, name] of names.entries()) {
        const position = definitions.indexOf(`function ${name}`) + 'function '.length;
        const symbol = store.listSymbols(scanned.snapshotId).find((entry) => entry.qualifiedName === name)!;
        assert.ok(symbol);
        const expected = (languageService.getReferencesAtPosition(paths[0]!, position) ?? []).flatMap((entry) => {
          if (entry.fileName === paths[0] && entry.textSpan.start === position) { return []; }
          const source = languageService.getProgram()!.getSourceFile(entry.fileName)!;
          const start = source.getLineAndCharacterOfPosition(entry.textSpan.start);
          const end = source.getLineAndCharacterOfPosition(entry.textSpan.start + entry.textSpan.length);
          return [`${relative(root, entry.fileName)}:${start.line + 1}:${start.character}:${end.line + 1}:${end.character}`];
        }).sort();
        const references = store.getReferences(scanned.snapshotId, symbol.id);
        const actual = references.map((entry) => `${entry.path}:${entry.startLine}:${entry.startColumn}:${entry.endLine}:${entry.endColumn}`).sort();
        assert.deepEqual(actual, expected, `SQLite references differ from the TypeScript language service for ${name}`);
        assert.equal(references.filter((entry) => entry.isCall).length, 1);
        const caller = store.listSymbols(scanned.snapshotId).find((entry) => entry.qualifiedName === `caller${index}`)!;
        const edges = graph.outgoing.get(caller.id) ?? [];
        assert.ok(edges.some((edge) => edge.targetId === symbol.id && edge.edgeType === 'CALLS'));
        assert.ok(edges.some((edge) => edge.targetId === symbol.id && edge.edgeType === 'DEPENDS_ON'));
        referenceChecks.push({ symbol: name, exactReferences: actual.length, calls: 1, matchesLanguageService: true });
      }
    } finally { languageService.dispose(); }
    const cli = join(project, 'apps/cli/dist/index.cjs');
    const doctor = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--db', scanned.dbPath, '--json'], { encoding: 'utf8' })) as { indexed: { snapshotId: string; scip: { indexers: { status: string }[]; reconciliation: unknown[] } } };
    assert.equal(doctor.indexed.snapshotId, scanned.snapshotId);
    assert.ok(doctor.indexed.scip.indexers.some((entry) => entry.status === 'complete'));
    const client = new Client({ name: 'reference-acceptance', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--db', scanned.dbPath, '--no-source'], stderr: 'pipe' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'find_references', arguments: { symbol: names[0], limit: 2 } });
      const payload = JSON.parse((result.content as { text: string }[])[0]!.text) as { total: number; references: unknown[]; nextOffset: number };
      assert.equal(payload.total, 3);
      assert.equal(payload.references.length, 2);
      assert.equal(payload.nextOffset, 2);
    } finally { await client.close(); }
    console.log(`SCIP/TypeScript language service: ${referenceChecks.length}/20 symbols match exact locations.`);
  } finally { store.close(); }

  // Independent manual inventory over tracked files of RepoLead itself, not the fixture.
  const real = await scanRepository({ rootPath: project, dbPath: join(temp, 'repolead.db'), repositoryName: 'RepoLead acceptance', scip: false });
  const realStore = await openStore(real.dbPath);
  let realReport: Record<string, unknown>;
  try {
    const tracked = git(project, 'ls-files', '-z').split('\0').filter(Boolean).filter((path) => existsSync(join(project, path)) && statSync(join(project, path)).isFile());
    assert.equal(real.counts.files, tracked.length);
    const expectedByPath: Record<string, string[]> = {
      'packages/domain/src/ids.ts': ['sha256', 'normalizeRepoPath', 'fileUri', 'symbolUri', 'SymbolIdentity', 'stableSymbolId', 'moduleUri', 'stableRepositoryId', 'contentHash'],
      'packages/retrieval/src/tokens.ts': ['TOKENIZER', 'countTokens', 'validateTokenBudget'],
    };
    for (const [path, names] of Object.entries(expectedByPath)) {
      const symbols = realStore.listSymbols(real.snapshotId, path);
      assert.deepEqual(symbols.map((entry) => entry.qualifiedName).sort(), [...names].sort());
      const source = readFileSync(join(project, path), 'utf8');
      for (const symbol of symbols) { assert.equal(contentHash(sliceSource(source, symbol)), symbol.contentHash); }
    }
    assert.ok(realStore.listExports(real.snapshotId).length > 0);
    assert.ok(realStore.listTests(real.snapshotId).length > 0);
    realReport = { trackedFiles: tracked.length, counts: real.counts, durationMs: real.durationMs,
      inspectedSymbols: expectedByPath, exports: realStore.listExports(real.snapshotId).length, exactSourceHashes: true, scip: false };
  } finally { realStore.close(); }
  const report = { generatedAt: new Date().toISOString(), scriptHash: contentHash(readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    runtime: { bun: process.versions.bun, typescriptLanguageService: ts.version },
    references: { comparedSymbols: referenceChecks.length, checks: referenceChecks, scanMs: scanned.durationMs, diagnostics: scanned.diagnostics,
      mcpPagination: true, compiledDoctorDiagnostics: true }, realRepository: realReport,
    limits: ['TypeScript language service comparison covers 20 functions with imports, direct calls, callback references and Unicode columns; it is not a full language conformance suite.',
      'RepoLead scan covers Git-tracked working-tree files; newly created untracked files are intentionally excluded.', 'Python SCIP references, generated routes and arbitrary dynamic framework composition need separate acceptance.'] };
  writeFileSync(join(project, 'benchmarks/deterministic-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ referenceSymbols: referenceChecks.length, realRepository: realReport, report: 'benchmarks/deterministic-acceptance.json' }, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import protobuf from 'protobufjs';

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);

/**
 * Subconjunto mínimo de scip.proto (números de campo verificados contra
 * sourcegraph/scip). Los campos desconocidos se ignoran al decodificar.
 */
const SCIP_PROTO = `
syntax = "proto3";
package scip;

message Index {
  Metadata metadata = 1;
  repeated Document documents = 2;
  repeated SymbolInformation external_symbols = 3;
}
message Metadata {
  string project_root = 3;
}
message Document {
  string relative_path = 1;
  repeated Occurrence occurrences = 2;
  repeated SymbolInformation symbols = 3;
  string language = 4;
  int32 position_encoding = 6;
}
message SingleLineRange {
  int32 line = 1;
  int32 start_character = 2;
  int32 end_character = 3;
}
message MultiLineRange {
  int32 start_line = 1;
  int32 start_character = 2;
  int32 end_line = 3;
  int32 end_character = 4;
}
message Occurrence {
  repeated int32 range = 1;
  string symbol = 2;
  int32 symbol_roles = 3;
  SingleLineRange single_line_range = 8;
  MultiLineRange multi_line_range = 9;
}
message SymbolInformation {
  string symbol = 1;
  repeated Relationship relationships = 4;
  string display_name = 6;
}
message Relationship {
  string symbol = 1;
  bool is_reference = 2;
  bool is_implementation = 3;
  bool is_type_definition = 4;
  bool is_definition = 5;
}
`;

const indexType = protobuf.parse(SCIP_PROTO).root.lookupType('scip.Index');

const DEFINITION_ROLE = 0x1;

export interface ScipOccurrence {
  symbol: string;
  isDefinition: boolean;
  /** 1-based. */
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
  positionEncoding?: 'utf8' | 'utf16' | 'utf32' | 'unknown';
}

export interface ScipRelationship {
  source: string;
  target: string;
  isImplementation: boolean;
}

export interface ScipIndex {
  documents: ScipDocument[];
  relationships: ScipRelationship[];
  ignoredLocalOccurrences?: number;
  malformedOccurrences?: number;
}

export interface ScipIndexerDiagnostic { tool: string; status: 'unavailable' | 'failed' | 'complete'; message: string; durationMs?: number }
export interface ScipIndexerOptions { onDiagnostic?: (diagnostic: ScipIndexerDiagnostic) => void; timeoutMs?: number }

interface RawOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
  singleLineRange?: { line?: number; startCharacter?: number; endCharacter?: number };
  multiLineRange?: { startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number };
}

interface RawSymbolInformation {
  symbol?: string;
  relationships?: { symbol?: string; isImplementation?: boolean }[];
}

interface RawDocument {
  relativePath?: string;
  occurrences?: RawOccurrence[];
  symbols?: RawSymbolInformation[];
  positionEncoding?: number;
}

function occurrenceRange(occurrence: RawOccurrence): Pick<ScipOccurrence, 'startLine' | 'startColumn' | 'endLine' | 'endColumn'> | null {
  // Typed ranges take precedence over legacy packed ranges (SCIP protocol).
  if (occurrence.singleLineRange) {
    const value = occurrence.singleLineRange;
    return { startLine: (value.line ?? 0) + 1, startColumn: value.startCharacter ?? 0,
      endLine: (value.line ?? 0) + 1, endColumn: value.endCharacter ?? 0 };
  }
  if (occurrence.multiLineRange) {
    const value = occurrence.multiLineRange;
    return { startLine: (value.startLine ?? 0) + 1, startColumn: value.startCharacter ?? 0,
      endLine: (value.endLine ?? 0) + 1, endColumn: value.endCharacter ?? 0 };
  }
  const range = occurrence.range;
  if (range?.length === 3) { return { startLine: range[0]! + 1, startColumn: range[1]!, endLine: range[0]! + 1, endColumn: range[2]! }; }
  if (range?.length === 4) { return { startLine: range[0]! + 1, startColumn: range[1]!, endLine: range[2]! + 1, endColumn: range[3]! }; }
  return null;
}

/** Un símbolo SCIP local (`local N`) no es direccionable entre archivos. */
function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

/** Último nombre del descriptor SCIP: `…/PaymentService#process().` → "process". */
export function scipShortName(symbol: string): string {
  const descriptor = /(?:`((?:``|[^`])+)`|([a-zA-Z\d_$+-]+))(?:\([^)]*\))?[.#:!/]$/.exec(symbol);
  if (descriptor) { return (descriptor[1] ?? descriptor[2] ?? '').replaceAll('``', '`'); }
  const parameter = /[([](?:`((?:``|[^`])+)`|([a-zA-Z\d_$+-]+))[)\]]$/.exec(symbol);
  return (parameter?.[1] ?? parameter?.[2] ?? '').replaceAll('``', '`');
}

export function parseScipIndex(data: Uint8Array): ScipIndex {
  const decoded = indexType.toObject(indexType.decode(data), { defaults: false }) as {
    documents?: RawDocument[];
  };

  const documents: ScipDocument[] = [];
  const relationships: ScipRelationship[] = [];
  let ignoredLocalOccurrences = 0;
  let malformedOccurrences = 0;

  for (const rawDocument of decoded.documents ?? []) {
    const occurrences: ScipOccurrence[] = [];
    for (const rawOccurrence of rawDocument.occurrences ?? []) {
      const range = occurrenceRange(rawOccurrence);
      const symbol = rawOccurrence.symbol;
      if (symbol && isLocalSymbol(symbol)) { ignoredLocalOccurrences += 1; continue; }
      if (!range || !symbol || range.startLine < 1 || range.endLine! < range.startLine || range.startColumn! < 0 || range.endColumn! < 0
        || (range.endLine === range.startLine && range.endColumn! < range.startColumn!)) {
        malformedOccurrences += 1;
        continue;
      }
      occurrences.push({
        symbol,
        isDefinition: ((rawOccurrence.symbolRoles ?? 0) & DEFINITION_ROLE) !== 0,
        ...range,
      });
    }
    documents.push({ relativePath: rawDocument.relativePath ?? '', occurrences,
      positionEncoding: rawDocument.positionEncoding === 1 ? 'utf8' : rawDocument.positionEncoding === 2 ? 'utf16' : rawDocument.positionEncoding === 3 ? 'utf32' : 'unknown' });

    for (const symbolInformation of rawDocument.symbols ?? []) {
      const source = symbolInformation.symbol;
      if (!source || isLocalSymbol(source)) {
        continue;
      }
      for (const relationship of symbolInformation.relationships ?? []) {
        if (relationship.symbol && relationship.isImplementation) {
          relationships.push({ source, target: relationship.symbol, isImplementation: true });
        }
      }
    }
  }

  return { documents, relationships, ignoredLocalOccurrences, malformedOccurrences };
}

function packageEntry(packageName: string, entryRelative: string): string | null {
  try {
    const packagePath = require_.resolve(`${packageName}/package.json`);
    return join(dirname(packagePath), entryRelative);
  } catch {
    return null;
  }
}

/**
 * Ejecuta scip-typescript sobre el repo y devuelve el índice parseado,
 * o null si el indexador no está disponible o falla (el scan sigue sin SCIP).
 */
async function runIndexer(tool: string, entry: string, rootPath: string, buildArgs: (output: string) => string[], options: ScipIndexerOptions): Promise<ScipIndex | null> {
  const started = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), 'repolead-scip-'));
  const outputPath = join(workDir, 'index.scip');
  try {
    await run(process.execPath, [entry, ...buildArgs(outputPath)], {
      cwd: rootPath,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs ?? 180000,
    });
    const index = parseScipIndex(await readFile(outputPath));
    // These two adapters wrap TypeScript/pyright JS indexers, whose legacy offsets are UTF-16.
    for (const document of index.documents) { if (document.positionEncoding === 'unknown') { document.positionEncoding = 'utf16'; } }
    options.onDiagnostic?.({ tool, status: 'complete', message: `${index.documents.length} documents indexed`, durationMs: Date.now() - started });
    return index;
  } catch (error) {
    options.onDiagnostic?.({ tool, status: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 2000), durationMs: Date.now() - started });
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function resolveScipEntrypoint(language: 'typescript' | 'python'): string | null {
  return language === 'typescript' ? packageEntry('@sourcegraph/scip-typescript', 'dist/src/main.js') : packageEntry('@sourcegraph/scip-python', 'index.js');
}

export async function indexWithScipTypescript(rootPath: string, options: ScipIndexerOptions = {}): Promise<ScipIndex | null> {
  const entry = resolveScipEntrypoint('typescript');
  if (!entry) {
    options.onDiagnostic?.({ tool: 'scip-typescript', status: 'unavailable', message: 'Packaged indexer entrypoint not found.' });
    return null;
  }
  return runIndexer('scip-typescript', entry, rootPath, (output) => {
    const args = ['index', '--output', output];
    if (!existsSync(join(rootPath, 'tsconfig.json'))) {
      args.push('--infer-tsconfig');
    }
    return args;
  }, options);
}

/** scip-python (pyright): referencias resueltas para repos Python. */
export async function indexWithScipPython(rootPath: string, options: ScipIndexerOptions = {}): Promise<ScipIndex | null> {
  const entry = resolveScipEntrypoint('python');
  if (!entry) {
    options.onDiagnostic?.({ tool: 'scip-python', status: 'unavailable', message: 'Packaged indexer entrypoint not found.' });
    return null;
  }
  return runIndexer('scip-python', entry, rootPath, (output) => [
    'index',
    '.',
    '--output',
    output,
    '--project-name',
    'repolead-scan',
    '--project-version',
    '0',
  ], options);
}

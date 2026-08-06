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
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
}

export interface ScipRelationship {
  source: string;
  target: string;
  isImplementation: boolean;
}

export interface ScipIndex {
  documents: ScipDocument[];
  relationships: ScipRelationship[];
}

interface RawOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
  singleLineRange?: { line?: number };
  multiLineRange?: { startLine?: number };
}

interface RawSymbolInformation {
  symbol?: string;
  relationships?: { symbol?: string; isImplementation?: boolean }[];
}

interface RawDocument {
  relativePath?: string;
  occurrences?: RawOccurrence[];
  symbols?: RawSymbolInformation[];
}

function occurrenceStartLine(occurrence: RawOccurrence): number | null {
  if (occurrence.range && occurrence.range.length >= 3) {
    return (occurrence.range[0] ?? 0) + 1;
  }
  if (occurrence.singleLineRange) {
    return (occurrence.singleLineRange.line ?? 0) + 1;
  }
  if (occurrence.multiLineRange) {
    return (occurrence.multiLineRange.startLine ?? 0) + 1;
  }
  return null;
}

/** Un símbolo SCIP local (`local N`) no es direccionable entre archivos. */
function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

/** Último nombre del descriptor SCIP: `…/PaymentService#process().` → "process". */
export function scipShortName(symbol: string): string {
  const tail = symbol.slice(symbol.lastIndexOf('/') + 1);
  const parts = tail.split(/[#.]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/[`()]/g, '');
}

export function parseScipIndex(data: Uint8Array): ScipIndex {
  const decoded = indexType.toObject(indexType.decode(data), { defaults: false }) as {
    documents?: RawDocument[];
  };

  const documents: ScipDocument[] = [];
  const relationships: ScipRelationship[] = [];

  for (const rawDocument of decoded.documents ?? []) {
    const occurrences: ScipOccurrence[] = [];
    for (const rawOccurrence of rawDocument.occurrences ?? []) {
      const startLine = occurrenceStartLine(rawOccurrence);
      const symbol = rawOccurrence.symbol;
      if (startLine === null || !symbol || isLocalSymbol(symbol)) {
        continue;
      }
      occurrences.push({
        symbol,
        isDefinition: ((rawOccurrence.symbolRoles ?? 0) & DEFINITION_ROLE) !== 0,
        startLine,
      });
    }
    documents.push({ relativePath: rawDocument.relativePath ?? '', occurrences });

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

  return { documents, relationships };
}

function scipTypescriptEntry(): string | null {
  try {
    const packagePath = require_.resolve('@sourcegraph/scip-typescript/package.json');
    return join(dirname(packagePath), 'dist/src/main.js');
  } catch {
    return null;
  }
}

/**
 * Ejecuta scip-typescript sobre el repo y devuelve el índice parseado,
 * o null si el indexador no está disponible o falla (el scan sigue sin SCIP).
 */
export async function indexWithScipTypescript(rootPath: string): Promise<ScipIndex | null> {
  const entry = scipTypescriptEntry();
  if (!entry) {
    return null;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'repolead-scip-'));
  const outputPath = join(workDir, 'index.scip');
  try {
    const args = [entry, 'index', '--output', outputPath];
    if (!existsSync(join(rootPath, 'tsconfig.json'))) {
      args.push('--infer-tsconfig');
    }
    await run(process.execPath, args, { cwd: rootPath, maxBuffer: 64 * 1024 * 1024 });
    return parseScipIndex(await readFile(outputPath));
  } catch {
    return null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

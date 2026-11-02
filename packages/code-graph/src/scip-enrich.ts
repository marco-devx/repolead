import type { ScipIndex, ScipOccurrence } from '@repolead/adapter-scip';
import { scipShortName } from '@repolead/adapter-scip';
import type { CallSite, CodeSymbol, Edge, InheritanceSite, SymbolReference } from '@repolead/domain';

export interface ReconciliationDiagnostic { path: string; line: number | null; symbol: string; reason: string }
export interface ScipEnrichment {
  edges: Edge[];
  references: SymbolReference[];
  resolvedReferences: number;
  unmappedDefinitions: number;
  diagnostics: ReconciliationDiagnostic[];
}
export interface ScipSource { id: string; content: string; calls: CallSite[]; inheritance?: InheritanceSite[] }

function contains(symbol: CodeSymbol, occurrence: ScipOccurrence): boolean {
  if (occurrence.startLine < symbol.startLine || occurrence.startLine > symbol.endLine) { return false; }
  if (symbol.span && occurrence.startColumn !== undefined) {
    if (occurrence.startLine === symbol.startLine && occurrence.startColumn < symbol.span.startColumn) { return false; }
    if (occurrence.startLine === symbol.endLine && occurrence.startColumn >= symbol.span.endColumn) { return false; }
  }
  return true;
}
function innermost(symbols: CodeSymbol[], occurrence: ScipOccurrence): CodeSymbol | null {
  const size = (symbol: CodeSymbol) => symbol.span ? symbol.span.endOffset - symbol.span.startOffset : (symbol.endLine - symbol.startLine + 1) * 100000;
  const candidates = symbols.filter((symbol) => contains(symbol, occurrence)).sort((a, b) => size(a) - size(b)
    || Number(a.kind === 'endpoint') - Number(b.kind === 'endpoint'));
  if (candidates.length > 1 && size(candidates[0]!) === size(candidates[1]!) && candidates[0]!.kind === candidates[1]!.kind) { return null; }
  return candidates[0] ?? null;
}
function shortNameOf(symbol: CodeSymbol) { return symbol.qualifiedName.split('.').at(-1) ?? symbol.qualifiedName; }

/** Compiler-resolved references retain every occurrence; only AST call sites become CALLS. */
export function buildScipEdges(scip: ScipIndex, symbols: CodeSymbol[], snapshotId: string,
  files: Map<string, ScipSource> = new Map()): ScipEnrichment {
  const byPath = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) { const list = byPath.get(symbol.path) ?? []; list.push(symbol); byPath.set(symbol.path, list); }
  const diagnostics: ReconciliationDiagnostic[] = [];
  const documents = scip.documents.map((document) => {
    const source = files.get(document.relativePath)?.content;
    const lines = source?.split('\n');
    const column = (line: number, character: number): number => {
      const text = lines?.[line - 1];
      if (document.positionEncoding === 'utf8' && text !== undefined) { return Buffer.from(text).subarray(0, character).toString('utf8').length; }
      if (document.positionEncoding === 'utf32' && text !== undefined) { return [...text].slice(0, character).join('').length; }
      return character;
    };
    return { ...document, occurrences: document.occurrences.flatMap((occurrence) => {
      if ((document.positionEncoding === 'utf8' || document.positionEncoding === 'utf32') && !lines) {
        diagnostics.push({ path: document.relativePath, line: occurrence.startLine, symbol: occurrence.symbol, reason: 'Source required to normalize non-UTF16 positions.' }); return [];
      }
      return [{ ...occurrence,
        startColumn: occurrence.startColumn === undefined ? undefined : column(occurrence.startLine, occurrence.startColumn),
        endColumn: occurrence.endColumn === undefined ? undefined : column(occurrence.endLine ?? occurrence.startLine, occurrence.endColumn) }];
    }) };
  });
  const scipToOur = new Map<string, CodeSymbol>();
  const ambiguous = new Set<string>();
  let unmappedDefinitions = 0;
  for (const document of documents) {
    const fileSymbols = byPath.get(document.relativePath) ?? [];
    for (const occurrence of document.occurrences.filter((entry) => entry.isDefinition)) {
      const name = scipShortName(occurrence.symbol);
      const candidates = fileSymbols.filter((symbol) => symbol.kind !== 'endpoint' && shortNameOf(symbol) === name);
      const match = innermost(candidates, occurrence);
      if (match && !ambiguous.has(occurrence.symbol)) {
        const previous = scipToOur.get(occurrence.symbol);
        if (previous && previous.id !== match.id) {
          ambiguous.add(occurrence.symbol); scipToOur.delete(occurrence.symbol);
          unmappedDefinitions += 1;
          diagnostics.push({ path: document.relativePath, line: occurrence.startLine, symbol: occurrence.symbol, reason: 'Multiple extracted definitions map to this SCIP symbol.' });
        } else { scipToOur.set(occurrence.symbol, match); }
      } else {
        unmappedDefinitions += 1;
        diagnostics.push({ path: document.relativePath, line: occurrence.startLine, symbol: occurrence.symbol,
          reason: candidates.length ? 'Definition range is ambiguous or disagrees with extracted spans.' : 'Definition kind/name not extracted by the syntax adapter.' });
      }
    }
  }
  const references: SymbolReference[] = [];
  const edges = new Map<string, Edge>();
  for (const document of documents) {
    const fileSymbols = byPath.get(document.relativePath) ?? [];
    const file = files.get(document.relativePath);
    for (const occurrence of document.occurrences) {
      const target = scipToOur.get(occurrence.symbol);
      if (!target) { continue; }
      const caller = innermost(fileSymbols, occurrence);
      const inheritance = (file?.inheritance ?? []).find((entry) => entry.startLine === occurrence.startLine && entry.startColumn === occurrence.startColumn
        && entry.endLine === (occurrence.endLine ?? occurrence.startLine) && entry.endColumn === occurrence.endColumn);
      const isCall = !occurrence.isDefinition && (file?.calls ?? []).some((call) => call.startLine === occurrence.startLine && call.startColumn === occurrence.startColumn
        && call.endLine === (occurrence.endLine ?? occurrence.startLine) && call.endColumn === occurrence.endColumn);
      const sourceId = inheritance ? fileSymbols.find((symbol) => symbol.qualifiedName === inheritance.source)?.id : caller?.id ?? file?.id;
      if (!sourceId) { continue; }
      const reference: SymbolReference = { snapshotId, targetId: target.id, sourceId, path: document.relativePath,
        startLine: occurrence.startLine, startColumn: occurrence.startColumn ?? 0, endLine: occurrence.endLine ?? occurrence.startLine,
        endColumn: occurrence.endColumn ?? occurrence.startColumn ?? 0, isDefinition: occurrence.isDefinition, isCall,
        analyzer: 'scip', scipSymbol: occurrence.symbol };
      references.push(reference);
      if (occurrence.isDefinition) { continue; }
      const edgeType = inheritance?.relation ?? (isCall ? 'CALLS' : 'DEPENDS_ON');
      const key = `${sourceId}\n${target.id}\n${edgeType}`;
      if (!edges.has(key)) {
        edges.set(key, { snapshotId, sourceId, targetId: target.id, edgeType, confidence: 0.95, analyzer: 'scip',
          evidence: { path: document.relativePath, line: occurrence.startLine, column: occurrence.startColumn,
            referenceKind: inheritance ? 'inheritance' : isCall ? 'call' : 'reference', scipSymbol: occurrence.symbol } });
      }
    }
  }
  for (const relationship of scip.relationships) {
    const source = scipToOur.get(relationship.source);
    const target = scipToOur.get(relationship.target);
    if (!source || !target) { continue; }
    // Class/interface heritage is classified by syntax, since SCIP's implementation
    // relationship alone cannot distinguish `extends` from `implements SomeClass`.
    if (source.kind !== 'method' || target.kind !== 'method') { continue; }
    const edgeType = 'IMPLEMENTS';
    const key = `${source.id}\n${target.id}\n${edgeType}`;
    edges.set(key, { snapshotId, sourceId: source.id, targetId: target.id, edgeType, confidence: 0.95, analyzer: 'scip',
      evidence: { scipSource: relationship.source, scipTarget: relationship.target } });
  }
  return { edges: [...edges.values()], references, resolvedReferences: references.filter((entry) => !entry.isDefinition).length, unmappedDefinitions, diagnostics };
}

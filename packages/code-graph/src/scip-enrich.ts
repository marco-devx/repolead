import type { ScipIndex } from '@repolead/adapter-scip';
import { scipShortName } from '@repolead/adapter-scip';
import type { CodeSymbol, Edge, EdgeType } from '@repolead/domain';

export interface ScipEnrichment {
  edges: Edge[];
  resolvedReferences: number;
  /** Definiciones SCIP sin símbolo tree-sitter correspondiente (desacuerdo entre analizadores). */
  unmappedDefinitions: number;
}

/** El símbolo más interno (menor span) de un path que contiene la línea dada. */
function enclosingSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) {
      continue;
    }
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) {
      best = symbol;
    }
  }
  return best;
}

function shortNameOf(symbol: CodeSymbol): string {
  const parts = symbol.qualifiedName.split('.');
  return parts[parts.length - 1] ?? symbol.qualifiedName;
}

function referenceEdgeType(target: CodeSymbol): EdgeType {
  return target.kind === 'function' || target.kind === 'method' ? 'CALLS' : 'DEPENDS_ON';
}

/**
 * Cruza el índice SCIP con los símbolos de Tree-sitter: cada definición SCIP
 * se mapea al símbolo propio por (path, línea, nombre); las referencias se
 * convierten en edges CALLS/DEPENDS_ON y las relaciones en IMPLEMENTS/EXTENDS.
 * SCIP es la fuente principal de referencias (regla de precedencia del plan);
 * los desacuerdos quedan contados en unmappedDefinitions.
 */
export function buildScipEdges(scip: ScipIndex, symbols: CodeSymbol[], snapshotId: string): ScipEnrichment {
  const byPath = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const list = byPath.get(symbol.path) ?? [];
    list.push(symbol);
    byPath.set(symbol.path, list);
  }

  const scipToOur = new Map<string, CodeSymbol>();
  let unmappedDefinitions = 0;

  for (const document of scip.documents) {
    const fileSymbols = byPath.get(document.relativePath);
    if (!fileSymbols) {
      continue;
    }
    for (const occurrence of document.occurrences) {
      if (!occurrence.isDefinition) {
        continue;
      }
      const shortName = scipShortName(occurrence.symbol);
      const candidates = fileSymbols.filter(
        (symbol) =>
          occurrence.startLine >= symbol.startLine &&
          occurrence.startLine <= symbol.endLine &&
          shortNameOf(symbol) === shortName,
      );
      const match = candidates.length > 0 ? enclosingSymbol(candidates, occurrence.startLine) : null;
      if (match) {
        scipToOur.set(occurrence.symbol, match);
      } else if (shortName.length > 0) {
        unmappedDefinitions += 1;
      }
    }
  }

  const edges = new Map<string, Edge>();
  let resolvedReferences = 0;

  for (const document of scip.documents) {
    const fileSymbols = byPath.get(document.relativePath);
    if (!fileSymbols) {
      continue;
    }
    for (const occurrence of document.occurrences) {
      if (occurrence.isDefinition) {
        continue;
      }
      const target = scipToOur.get(occurrence.symbol);
      if (!target) {
        continue;
      }
      const caller = enclosingSymbol(fileSymbols, occurrence.startLine);
      if (!caller || caller.id === target.id) {
        continue;
      }
      const edgeType = referenceEdgeType(target);
      const key = `${caller.id}\n${target.id}\n${edgeType}`;
      if (!edges.has(key)) {
        edges.set(key, {
          snapshotId,
          sourceId: caller.id,
          targetId: target.id,
          edgeType,
          confidence: 0.9,
          analyzer: 'scip',
          evidence: { path: document.relativePath, line: occurrence.startLine, scipSymbol: occurrence.symbol },
        });
      }
      resolvedReferences += 1;
    }
  }

  for (const relationship of scip.relationships) {
    const source = scipToOur.get(relationship.source);
    const target = scipToOur.get(relationship.target);
    if (!source || !target) {
      continue;
    }
    const edgeType: EdgeType = source.kind === 'class' && target.kind === 'class' ? 'EXTENDS' : 'IMPLEMENTS';
    const key = `${source.id}\n${target.id}\n${edgeType}`;
    if (!edges.has(key)) {
      edges.set(key, {
        snapshotId,
        sourceId: source.id,
        targetId: target.id,
        edgeType,
        confidence: 0.95,
        analyzer: 'scip',
        evidence: { scipSource: relationship.source, scipTarget: relationship.target },
      });
    }
  }

  return { edges: [...edges.values()], resolvedReferences, unmappedDefinitions };
}

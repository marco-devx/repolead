import { posix } from 'node:path';

import type { CodeSymbol, Edge, KnowledgeDocument, SourceFile } from '@repolead/domain';

export function isDocumentation(path: string, configuredPaths: string[]): boolean {
  return /\.(md|mdx|txt|rst)$/i.test(path) && configuredPaths.some((entry) =>
    entry === '.' || path === entry || path.startsWith(`${entry}/`));
}

/** Only explicit relative file links create relations. Naming similarity is not a code mapping. */
export function documentationEdges(documents: KnowledgeDocument[], files: SourceFile[], symbols: CodeSymbol[]): Edge[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const edges = new Map<string, Edge>();
  for (const document of documents) {
    const lines = document.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index]!.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const raw = match[1]!;
        if (/^[a-z][a-z\d+.-]*:|^\/|^#/i.test(raw)) { continue; }
        let decoded: string;
        try { decoded = decodeURIComponent(raw); } catch { continue; }
        const [pathname = '', fragment = ''] = decoded.split('#');
        const path = posix.normalize(posix.join(posix.dirname(document.path), pathname));
        const target = byPath.get(path);
        if (!target) { continue; }
        const lineMatch = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
        const line = lineMatch ? Number(lineMatch[1]) : null;
        const mapped = line === null ? [] : symbols.filter((symbol) => symbol.path === path && symbol.startLine <= line && symbol.endLine >= line);
        for (const sourceId of [target.id, ...mapped.map((symbol) => symbol.id)]) {
          edges.set(`${sourceId}\n${document.id}`, { snapshotId: document.snapshotId, sourceId, targetId: document.id,
            edgeType: 'DOCUMENTED_BY', confidence: 1, analyzer: 'markdown-link',
            evidence: { path: document.path, line: index + 1, targetPath: path, targetLine: line } });
        }
      }
    }
  }
  return [...edges.values()];
}

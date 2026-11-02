import type { ImportedTypeUse, Node, TypedDeclaration } from '@repolead/adapter-tree-sitter';
import { createParser, importedTypeUses, measureSyntax } from '@repolead/adapter-tree-sitter';
import type { CallSite, ExportBinding, HttpRoute, InheritanceSite, SourceSpan, SymbolKind } from '@repolead/domain';

export interface ExtractedSymbol {
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  startLine: number;
  endLine: number;
  span?: SourceSpan;
  route?: HttpRoute;
  parent: string | null;
  metrics?: Record<string, number>;
}

export interface ExtractedImport {
  /** Dotted specifier: `app.services.auth` o relativo `..models`. */
  specifier: string;
  startLine: number;
}

export interface ExtractedTest {
  name: string;
  startLine: number;
  endLine: number;
  span?: SourceSpan;
}

export interface FileExtraction {
  typeUses?: ImportedTypeUse[];
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  tests: ExtractedTest[];
  calls?: CallSite[];
  inheritance?: InheritanceSite[];
  diagnostics?: { line: number; message: string }[];
  exports?: Pick<ExportBinding, 'exportedName' | 'localName' | 'sourceModule' | 'typeOnly' | 'startLine'>[];
  metrics?: Record<string, number>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'websocket']);

export function isPythonTestPath(path: string): boolean {
  return /(^|\/)test_[^/]+\.py$|_test\.py$/.test(path);
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}

function compact(text: string | undefined | null): string | null {
  return text ? text.replace(/\s+/g, ' ').trim() : null;
}

function functionSignature(node: Node): string | null {
  const parameters = compact(node.childForFieldName('parameters')?.text);
  if (parameters === null) {
    return null;
  }
  const returnType = compact(node.childForFieldName('return_type')?.text);
  return `${parameters}${returnType ? ` -> ${returnType}` : ''}`;
}

function stringValue(node: Node | null | undefined): string | null {
  if (!node || node.type !== 'string') {
    return null;
  }
  return node.text.replace(/^[rbfu]*['"]{1,3}/i, '').replace(/['"]{1,3}$/, '');
}

/** `@app.get("/users")` / `@router.post(...)` → endpoint `GET /users`. */
function endpointFromDecorators(decorators: Node[]): { name: string; node: Node } | null {
  for (const decorator of decorators) {
    const call = decorator.namedChildren.find((child) => child?.type === 'call');
    const callee = call?.childForFieldName('function');
    if (!call || callee?.type !== 'attribute') {
      continue;
    }
    const method = callee.childForFieldName('attribute')?.text ?? '';
    const route = stringValue(call.childForFieldName('arguments')?.namedChildren[0]);
    if (HTTP_METHODS.has(method) && route !== null && route.startsWith('/')) {
      return { name: `${method.toUpperCase()} ${route}`, node: decorator };
    }
  }
  return null;
}

/**
 * Extrae símbolos, imports y tests de un archivo Python caminando el AST.
 * Chunks = unidades del lenguaje: clase, función, método, endpoint FastAPI.
 */
export async function extractPythonSource(path: string, source: string): Promise<FileExtraction> {
  const parser = await createParser('python');
  try {
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: [], imports: [], tests: [] };
  }
  try {

  const symbols: ExtractedSymbol[] = [];
  const typedDeclarations: TypedDeclaration[] = [];
  const imports: ExtractedImport[] = [];
  const tests: ExtractedTest[] = [];
  const calls: CallSite[] = [];
  const inheritance: InheritanceSite[] = [];
  const diagnostics: { line: number; message: string }[] = tree.rootNode.hasError ? [{ line: 1, message: 'Tree-sitter reported syntax errors; extraction may be incomplete.' }] : [];
  let explicitExports: string[] | null = null;
  const isTestFile = isPythonTestPath(path);

  const addSymbol = (
    node: Node,
    qualifiedName: string,
    kind: SymbolKind,
    signature: string | null = null,
    parent: string | null = null,
    start: Node = node,
    route?: HttpRoute,
  ): void => {
    typedDeclarations.push({ node, name: qualifiedName, kind, parent });
    symbols.push({ qualifiedName, kind, signature, startLine: line(start), endLine: node.endPosition.row + 1, parent,
      metrics: measureSyntax(node, kind === 'function' || kind === 'method'),
      span: { startOffset: start.startIndex, endOffset: node.endIndex, startColumn: start.startPosition.column, endColumn: node.endPosition.column },
      ...(route ? { route } : {}) });
  };

  const visitFunction = (node: Node, decorators: Node[], parentClass: string | null): void => {
    const name = node.childForFieldName('name')?.text;
    if (!name) {
      return;
    }
    const endpoint = endpointFromDecorators(decorators);
    const anchor = decorators[0] ?? node;
    const qualifiedName = parentClass ? `${parentClass}.${name}` : name;
    if (endpoint) {
      const [method, ...routePath] = endpoint.name.split(' ');
      addSymbol(node, endpoint.name, 'endpoint', null, null, anchor,
        { framework: 'fastapi', method: method!, path: routePath.join(' '), handler: qualifiedName, scope: 'declared' });
    }
    addSymbol(node, qualifiedName, parentClass ? 'method' : 'function', functionSignature(node), parentClass, anchor);
    if (isTestFile && name.startsWith('test_')) {
      tests.push({ name: qualifiedName, startLine: line(anchor), endLine: node.endPosition.row + 1,
        span: { startOffset: anchor.startIndex, endOffset: node.endIndex, startColumn: anchor.startPosition.column, endColumn: node.endPosition.column } });
    }
  };

  const visitClassBody = (classNode: Node, className: string): void => {
    for (const child of classNode.childForFieldName('body')?.namedChildren ?? []) {
      if (child?.type === 'function_definition') {
        visitFunction(child, [], className);
      } else if (child?.type === 'decorated_definition') {
        const definition = child.childForFieldName('definition');
        if (definition?.type === 'function_definition') {
          visitFunction(definition, child.namedChildren.filter((n): n is Node => n?.type === 'decorator'), className);
        }
      }
    }
  };

  const visitTopLevel = (node: Node, decorators: Node[] = []): void => {
    switch (node.type) {
      case 'decorated_definition': {
        const definition = node.childForFieldName('definition');
        if (definition) {
          visitTopLevel(definition, node.namedChildren.filter((n): n is Node => n?.type === 'decorator'));
        }
        break;
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'class', null, null, decorators[0] ?? node);
          for (const child of node.childForFieldName('superclasses')?.namedChildren ?? []) {
            const base = child?.type === 'attribute' ? child.childForFieldName('attribute') : child;
            if (base?.type === 'identifier') {
              inheritance.push({ source: name, relation: 'EXTENDS', startLine: line(base), startColumn: base.startPosition.column,
                endLine: base.endPosition.row + 1, endColumn: base.endPosition.column });
            }
          }
          visitClassBody(node, name);
        }
        break;
      }
      case 'function_definition':
        visitFunction(node, decorators, null);
        break;
      case 'import_statement': {
        for (const child of node.namedChildren) {
          if (child?.type === 'dotted_name') {
            imports.push({ specifier: child.text, startLine: line(node) });
          } else if (child?.type === 'aliased_import') {
            const name = child.childForFieldName('name');
            if (name) {
              imports.push({ specifier: name.text, startLine: line(node) });
            }
          }
        }
        break;
      }
      case 'import_from_statement': {
        const moduleName = node.childForFieldName('module_name');
        if (moduleName) {
          imports.push({ specifier: moduleName.text, startLine: line(node) });
        }
        break;
      }
      default:
        break;
    }
  };

  for (const child of tree.rootNode.namedChildren) {
    if (child) {
      visitTopLevel(child);
      const assignment = child.type === 'expression_statement' ? child.namedChildren.find((node) => node?.type === 'assignment') : null;
      const name = assignment?.childForFieldName('left');
      if (assignment && name?.type === 'identifier') {
        if (name.text === '__all__') {
          const value = assignment.childForFieldName('right');
          const entries = value && ['list', 'tuple'].includes(value.type) ? value.namedChildren.map(stringValue) : null;
          if (entries?.every((entry) => entry !== null)) { explicitExports = entries as string[]; }
          else { diagnostics.push({ line: line(assignment), message: 'Dynamic Python __all__; exported-name filtering is unresolved.' }); }
        } else if (!name.text.startsWith('_')) { addSymbol(assignment, name.text, 'variable'); }
      }
    }
  }

  symbols.sort((left, right) => left.startLine - right.startLine);
  tests.sort((left, right) => left.startLine - right.startLine);
  const stack = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'call') {
      let callee = node.childForFieldName('function');
      if (callee?.type === 'attribute') { callee = callee.childForFieldName('attribute'); }
      if (callee?.type === 'identifier') {
        calls.push({ startLine: line(callee), startColumn: callee.startPosition.column,
          endLine: callee.endPosition.row + 1, endColumn: callee.endPosition.column });
      }
    }
    for (const child of node.namedChildren) { if (child) { stack.push(child); } }
  }
  const publicSymbols = symbols.filter((symbol) => symbol.parent === null && symbol.kind !== 'endpoint');
  const exportedNames = explicitExports ?? publicSymbols.filter((symbol) => !symbol.qualifiedName.startsWith('_')).map((symbol) => symbol.qualifiedName);
  const exports = [...new Set(exportedNames)].map((name) => ({ exportedName: name, localName: name, sourceModule: null,
    typeOnly: false, startLine: publicSymbols.find((symbol) => symbol.qualifiedName === name)?.startLine ?? 1 }));
  return { symbols, imports, tests, calls, inheritance, diagnostics, exports, metrics: measureSyntax(tree.rootNode, false),
    typeUses: importedTypeUses(tree.rootNode, typedDeclarations, new Set(exportedNames), true) };
  } finally { tree.delete(); }
  } finally { parser.delete(); }
}

/**
 * Resuelve un import dotted de Python a un archivo del repo:
 * `.mod`/`..pkg.mod` relativo al archivo, `app.services.auth` desde la raíz
 * (probando también `src/`), con fallback a `__init__.py` para paquetes.
 */
export function resolvePythonImport(fromPath: string, specifier: string, tracked: Set<string>): string | null {
  const candidates: string[] = [];
  if (specifier.startsWith('.')) {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 1;
    const rest = specifier.slice(dots).split('.').filter(Boolean).join('/');
    let base = fromPath.split('/').slice(0, -1);
    for (let up = 1; up < dots; up += 1) {
      base = base.slice(0, -1);
    }
    const prefix = [...base, rest].filter(Boolean).join('/');
    candidates.push(prefix);
  } else {
    const asPath = specifier.split('.').join('/');
    candidates.push(asPath, `src/${asPath}`);
  }
  for (const candidate of candidates) {
    for (const suffix of ['.py', '/__init__.py']) {
      const path = `${candidate}${suffix}`;
      if (tracked.has(path)) {
        return path;
      }
    }
  }
  return null;
}

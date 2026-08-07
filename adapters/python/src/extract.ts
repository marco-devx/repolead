import type { Node } from '@repolead/adapter-tree-sitter';
import { createParser } from '@repolead/adapter-tree-sitter';
import type { SymbolKind } from '@repolead/domain';

export interface ExtractedSymbol {
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  startLine: number;
  endLine: number;
  parent: string | null;
}

export interface ExtractedImport {
  /** Dotted specifier: `app.services.auth` o relativo `..models`. */
  specifier: string;
  startLine: number;
}

export interface ExtractedTest {
  name: string;
  startLine: number;
}

export interface FileExtraction {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  tests: ExtractedTest[];
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
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: [], imports: [], tests: [] };
  }

  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const tests: ExtractedTest[] = [];
  const isTestFile = isPythonTestPath(path);

  const addSymbol = (
    node: Node,
    qualifiedName: string,
    kind: SymbolKind,
    signature: string | null = null,
    parent: string | null = null,
  ): void => {
    symbols.push({ qualifiedName, kind, signature, startLine: line(node), endLine: node.endPosition.row + 1, parent });
  };

  const visitFunction = (node: Node, decorators: Node[], parentClass: string | null): void => {
    const name = node.childForFieldName('name')?.text;
    if (!name) {
      return;
    }
    const endpoint = endpointFromDecorators(decorators);
    const anchor = decorators[0] ?? node;
    if (endpoint) {
      addSymbol(anchor, endpoint.name, 'endpoint');
    }
    const qualifiedName = parentClass ? `${parentClass}.${name}` : name;
    addSymbol(anchor, qualifiedName, parentClass ? 'method' : 'function', functionSignature(node), parentClass);
    if (isTestFile && name.startsWith('test_')) {
      tests.push({ name: qualifiedName, startLine: line(anchor) });
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
          addSymbol(decorators[0] ?? node, name, 'class');
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
    }
  }

  symbols.sort((left, right) => left.startLine - right.startLine);
  tests.sort((left, right) => left.startLine - right.startLine);
  return { symbols, imports, tests };
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

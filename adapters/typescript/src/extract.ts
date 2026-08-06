import type { SymbolKind } from '@repolead/domain';
import type { GrammarName, Node } from '@repolead/adapter-tree-sitter';
import { createParser } from '@repolead/adapter-tree-sitter';

export interface ExtractedSymbol {
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  startLine: number;
  endLine: number;
  /** Qualified name del símbolo contenedor (clase), si existe. */
  parent: string | null;
}

export interface ExtractedImport {
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

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all']);
const ROUTER_NAMES = new Set(['app', 'router', 'server', 'api']);
const TEST_FUNCTIONS = new Set(['test', 'it']);

function grammarFor(path: string): GrammarName {
  return path.endsWith('.tsx') || path.endsWith('.jsx') ? 'tsx' : 'typescript';
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}

function compactText(node: Node | null): string | null {
  return node ? node.text.replace(/\s+/g, ' ').trim() : null;
}

function callSignature(node: Node): string | null {
  const parameters = compactText(node.childForFieldName('parameters'));
  if (parameters === null) {
    return null;
  }
  const returnType = compactText(node.childForFieldName('return_type'));
  return `${parameters}${returnType ?? ''}`;
}

function stringLiteralValue(node: Node | null): string | null {
  if (!node || node.type !== 'string') {
    return null;
  }
  return node.text.slice(1, -1);
}

export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Extrae símbolos, imports y tests de un archivo TS/TSX caminando el AST.
 * Los chunks son unidades reales del lenguaje: clase, método, función,
 * interface, endpoint — nunca ventanas de N tokens.
 */
export async function extractFromSource(path: string, source: string): Promise<FileExtraction> {
  const parser = await createParser(grammarFor(path));
  const tree = parser.parse(source);
  if (!tree) {
    return { symbols: [], imports: [], tests: [] };
  }

  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const tests: ExtractedTest[] = [];

  const addSymbol = (
    node: Node,
    qualifiedName: string,
    kind: SymbolKind,
    signature: string | null = null,
    parent: string | null = null,
  ): void => {
    symbols.push({
      qualifiedName,
      kind,
      signature,
      startLine: line(node),
      endLine: node.endPosition.row + 1,
      parent,
    });
  };

  const visitClassBody = (classNode: Node, className: string): void => {
    const body = classNode.childForFieldName('body');
    for (const member of body?.namedChildren ?? []) {
      if (!member) {
        continue;
      }
      if (member.type === 'method_definition') {
        const name = member.childForFieldName('name')?.text;
        if (name) {
          addSymbol(member, `${className}.${name}`, 'method', callSignature(member), className);
        }
      } else if (member.type === 'public_field_definition') {
        const value = member.childForFieldName('value');
        const name = member.childForFieldName('name')?.text;
        if (name && (value?.type === 'arrow_function' || value?.type === 'function_expression')) {
          addSymbol(member, `${className}.${name}`, 'method', callSignature(value), className);
        }
      }
    }
  };

  const visitDeclaration = (node: Node): void => {
    switch (node.type) {
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'class');
          visitClassBody(node, name);
        }
        break;
      }
      case 'interface_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'interface');
        }
        break;
      }
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'enum');
        }
        break;
      }
      case 'type_alias_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'type');
        }
        break;
      }
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addSymbol(node, name, 'function', callSignature(node));
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const declarator of node.namedChildren) {
          if (declarator?.type !== 'variable_declarator') {
            continue;
          }
          const name = declarator.childForFieldName('name')?.text;
          const value = declarator.childForFieldName('value');
          if (!name) {
            continue;
          }
          if (value?.type === 'arrow_function' || value?.type === 'function_expression') {
            addSymbol(declarator, name, 'function', callSignature(value));
          }
        }
        break;
      }
      default:
        break;
    }
  };

  for (const child of tree.rootNode.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === 'import_statement') {
      const specifier = stringLiteralValue(child.childForFieldName('source'));
      if (specifier) {
        imports.push({ specifier, startLine: line(child) });
      }
      continue;
    }
    if (child.type === 'export_statement') {
      const declaration = child.childForFieldName('declaration');
      if (declaration) {
        visitDeclaration(declaration);
      }
      continue;
    }
    visitDeclaration(child);
  }

  // Endpoints HTTP (heurística Express-like) y tests: recorrido completo de calls.
  const stack: Node[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const firstArgument = node.childForFieldName('arguments')?.namedChildren[0] ?? null;
      if (callee?.type === 'member_expression') {
        const objectName = callee.childForFieldName('object')?.text ?? '';
        const property = callee.childForFieldName('property')?.text ?? '';
        const route = stringLiteralValue(firstArgument);
        if (HTTP_METHODS.has(property) && ROUTER_NAMES.has(objectName) && route !== null) {
          addSymbol(node, `${property.toUpperCase()} ${route}`, 'endpoint');
        }
      } else if (callee?.type === 'identifier' && TEST_FUNCTIONS.has(callee.text)) {
        const testName = stringLiteralValue(firstArgument);
        if (testName !== null) {
          tests.push({ name: testName, startLine: line(node) });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) {
        stack.push(child);
      }
    }
  }

  symbols.sort((left, right) => left.startLine - right.startLine);
  tests.sort((left, right) => left.startLine - right.startLine);

  return { symbols, imports, tests };
}

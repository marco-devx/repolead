import type { CallSite, ExportBinding, HttpRoute, InheritanceSite, SourceSpan, SymbolKind } from '@repolead/domain';
import type { GrammarName, ImportedTypeUse, Node, TypedDeclaration } from '@repolead/adapter-tree-sitter';
import { createParser, importedTypeUses, measureSyntax } from '@repolead/adapter-tree-sitter';

export interface ExtractedSymbol {
  qualifiedName: string;
  kind: SymbolKind;
  signature: string | null;
  visibility?: 'public' | 'protected' | 'private';
  startLine: number;
  endLine: number;
  span?: SourceSpan;
  route?: HttpRoute;
  parent: string | null;
  metrics?: Record<string, number>;
}
export interface ExtractedImport { specifier: string; startLine: number }
export interface ExtractedTest { name: string; startLine: number; endLine: number; span?: SourceSpan }
export type ExtractedExport = Pick<ExportBinding, 'exportedName' | 'localName' | 'sourceModule' | 'typeOnly' | 'startLine'>;
export interface FileExtraction {
  typeUses?: ImportedTypeUse[];
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  tests: ExtractedTest[];
  exports?: ExtractedExport[];
  diagnostics?: { line: number; message: string }[];
  calls?: CallSite[];
  inheritance?: InheritanceSite[];
  metrics?: Record<string, number>;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']);
const ROUTER_NAMES = ['app', 'router', 'server', 'api'];
const TEST_FUNCTIONS = new Set(['test', 'it']);
const grammarFor = (path: string): GrammarName => path.endsWith('.tsx') || path.endsWith('.jsx') ? 'tsx' : 'typescript';
const line = (node: Node) => node.startPosition.row + 1;
const compactText = (node: Node | null) => node ? node.text.replace(/\s+/g, ' ').trim() : null;
const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => child !== null);
function span(node: Node, start = node): SourceSpan {
  return { startOffset: start.startIndex, endOffset: node.endIndex, startColumn: start.startPosition.column, endColumn: node.endPosition.column };
}
function callSignature(node: Node): string | null {
  const parameters = compactText(node.childForFieldName('parameters'));
  return parameters === null ? null : `${parameters}${compactText(node.childForFieldName('return_type')) ?? ''}`;
}
function stringLiteralValue(node: Node | null | undefined): string | null {
  if (!node || !['string', 'template_string'].includes(node.type) || named(node).some((child) => child.type === 'template_substitution')) { return null; }
  // Decode common escapes without executing source. Unknown escapes remain explicit literals.
  return node.text.slice(1, -1).replace(/\\(['"`\\])/g, '$1');
}
function staticPaths(node: Node | null | undefined): string[] | null {
  if (!node) { return ['']; }
  const literal = stringLiteralValue(node);
  if (literal !== null) { return [literal]; }
  if (node.type === 'array') {
    const values = named(node).map(stringLiteralValue);
    return values.every((value) => value !== null) ? values as string[] : null;
  }
  if (node.type === 'object') {
    const pair = named(node).find((child) => child.type === 'pair' && child.childForFieldName('key')?.text.replace(/['"]/g, '') === 'path');
    return pair ? staticPaths(pair.childForFieldName('value')) : [''];
  }
  return null;
}
const joinRoute = (prefix: string, path: string) => `/${[prefix, path].map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
export const isTestPath = (path: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Static declarations and literal routes; no repository code is executed. */
export async function extractFromSource(path: string, source: string): Promise<FileExtraction> {
  const parser = await createParser(grammarFor(path));
  try {
    const tree = parser.parse(source);
    if (!tree) { return { symbols: [], imports: [], tests: [], exports: [] }; }
    try {
      const symbols: ExtractedSymbol[] = [];
      const typedDeclarations: TypedDeclaration[] = [];
      const imports: ExtractedImport[] = [];
      const tests: ExtractedTest[] = [];
      const exports: ExtractedExport[] = [];
      const diagnostics: { line: number; message: string }[] = [];
      if (tree.rootNode.hasError) { diagnostics.push({ line: 1, message: 'Tree-sitter reported syntax errors; extraction may be incomplete.' }); }
      const calls: CallSite[] = [];
      const inheritance: InheritanceSite[] = [];
      const nestNames = new Map<string, string>();
      const nestNamespaces = new Set<string>();
      const expressFactories = new Set(['express', 'Router']);
      const routers = new Set(ROUTER_NAMES);
      const top = named(tree.rootNode);
      for (const child of top.filter((node) => node.type === 'import_statement')) {
        const specifier = stringLiteralValue(child.childForFieldName('source'));
        if (specifier) { imports.push({ specifier, startLine: line(child) }); }
        const stack = [child];
        while (stack.length) {
          const node = stack.pop()!;
          if (node.type === 'import_specifier') {
            const imported = node.childForFieldName('name')?.text;
            const local = node.childForFieldName('alias')?.text ?? imported;
            if (imported && local && specifier === '@nestjs/common') { nestNames.set(local, imported); }
            if (imported === 'Router' && local && specifier === 'express') { expressFactories.add(local); }
          }
          if (node.type === 'namespace_import' && specifier === '@nestjs/common') { named(node).forEach((entry) => nestNamespaces.add(entry.text)); }
          if (node.type === 'import_clause' && specifier === 'express') {
            named(node).filter((entry) => entry.type === 'identifier').forEach((entry) => expressFactories.add(entry.text));
          }
          stack.push(...named(node));
        }
      }
      const nestDecorator = (node: Node): { name: string; args: Node[] } | null => {
        const call = named(node).find((child) => child.type === 'call_expression');
        const callee = call?.childForFieldName('function');
        if (!call || !callee) { return null; }
        const name = callee.type === 'identifier' ? nestNames.get(callee.text)
          : callee.type === 'member_expression' && nestNamespaces.has(callee.childForFieldName('object')?.text ?? '') ? callee.childForFieldName('property')?.text : null;
        return name ? { name, args: named(call.childForFieldName('arguments')) } : null;
      };
      const addSymbol = (node: Node, qualifiedName: string, kind: SymbolKind, signature: string | null = null,
        parent: string | null = null, start = node, route?: HttpRoute): void => {
        typedDeclarations.push({ node, name: qualifiedName, kind, parent });
        symbols.push({ qualifiedName, kind, signature, startLine: line(start), endLine: node.endPosition.row + 1,
          ...(kind === 'method' ? { visibility: node.childForFieldName('name')?.text.startsWith('#') ? 'private' as const
            : named(node).find((child) => child.type === 'accessibility_modifier')?.text === 'private' ? 'private' as const
            : named(node).find((child) => child.type === 'accessibility_modifier')?.text === 'protected' ? 'protected' as const : 'public' as const } : {}),
          metrics: measureSyntax(node, kind === 'function' || kind === 'method'),
          span: span(node, start), parent, ...(route ? { route } : {}) });
      };
      const addExport = (node: Node, exportedName: string, localName: string | null, sourceModule: string | null = null, typeOnly = false) => {
        exports.push({ exportedName, localName, sourceModule, typeOnly, startLine: line(node) });
      };
      const visitClass = (node: Node, className: string, decorators: Node[]) => {
        const clauses = named(node).flatMap((child) => child.type === 'class_heritage' ? named(child) : child.type === 'extends_type_clause' ? [child] : []);
        for (const clause of clauses) {
          for (let base of named(clause)) {
            if (base.type === 'generic_type') { base = base.childForFieldName('name') ?? base; }
            if (['nested_type_identifier', 'member_expression'].includes(base.type)) { base = base.childForFieldName('name') ?? base.childForFieldName('property') ?? base; }
            if (['identifier', 'type_identifier'].includes(base.type)) {
              inheritance.push({ source: className, relation: clause.type === 'implements_clause' ? 'IMPLEMENTS' : 'EXTENDS',
                startLine: line(base), startColumn: base.startPosition.column, endLine: base.endPosition.row + 1, endColumn: base.endPosition.column });
            }
          }
        }
        const controller = decorators.map(nestDecorator).find((entry) => entry?.name === 'Controller');
        const prefixes = controller ? staticPaths(controller.args[0]) : null;
        if (controller && prefixes === null) { diagnostics.push({ line: line(node), message: `Dynamic Nest controller prefix: ${className}; routes unresolved.` }); }
        let pending: Node[] = [];
        for (const member of named(node.childForFieldName('body'))) {
          if (member.type === 'decorator') { pending.push(member); continue; }
          const memberDecorators = [...pending, ...named(member).filter((child) => child.type === 'decorator')];
          pending = [];
          const name = member.childForFieldName('name')?.text;
          const value = member.childForFieldName('value');
          if (!name) { continue; }
          if (member.type === 'method_definition' || member.type === 'method_signature'
            || (member.type === 'public_field_definition' && ['arrow_function', 'function_expression'].includes(value?.type ?? ''))) {
            const methodName = `${className}.${name}`;
            addSymbol(member, methodName, 'method', callSignature(value ?? member), className, memberDecorators[0] ?? member);
            if (prefixes) {
              for (const decorator of memberDecorators) {
                const route = nestDecorator(decorator);
                if (!route || !HTTP_METHODS.has(route.name.toLowerCase())) { continue; }
                const paths = staticPaths(route.args[0]);
                if (!paths) { diagnostics.push({ line: line(decorator), message: `Dynamic Nest route: ${methodName}; path unresolved.` }); continue; }
                for (const prefix of prefixes) {
                  for (const routePath of paths) {
                    const fullPath = joinRoute(prefix, routePath);
                    addSymbol(member, `${route.name.toUpperCase()} ${fullPath}`, 'endpoint', null, null, memberDecorators[0] ?? member,
                      { framework: 'nest', method: route.name.toUpperCase(), path: fullPath, handler: methodName, scope: 'declared' });
                  }
                }
              }
            }
          }
        }
      };
      const visitDeclaration = (node: Node, decorators: Node[] = [], exported = false, defaultExport = false): string[] => {
        const names: string[] = [];
        const name = node.childForFieldName('name')?.text ?? (defaultExport ? 'default' : null);
        const kinds: Record<string, SymbolKind> = { class_declaration: 'class', abstract_class_declaration: 'class', class: 'class',
          interface_declaration: 'interface', enum_declaration: 'enum', type_alias_declaration: 'type', function_declaration: 'function', generator_function_declaration: 'function', function_expression: 'function', arrow_function: 'function' };
        const kind = kinds[node.type];
        if (kind && name) {
          names.push(name);
          addSymbol(node, name, kind, kind === 'function' ? callSignature(node) : null, null, decorators[0] ?? node);
          if (kind === 'class' || kind === 'interface') { visitClass(node, name, decorators); }
        }
        if (['lexical_declaration', 'variable_declaration'].includes(node.type)) {
          for (const declaration of named(node).filter((entry) => entry.type === 'variable_declarator')) {
            const variable = declaration.childForFieldName('name');
            const value = declaration.childForFieldName('value');
            if (variable?.type !== 'identifier') { continue; }
            names.push(variable.text);
            if (['arrow_function', 'function_expression'].includes(value?.type ?? '')) { addSymbol(declaration, variable.text, 'function', callSignature(value!)); }
            else if (exported) { addSymbol(declaration, variable.text, 'variable'); }
            const factory = value?.type === 'call_expression' ? value.childForFieldName('function')?.text : null;
            if (factory && (expressFactories.has(factory) || [...expressFactories].some((entry) => factory === `${entry}.Router`))) { routers.add(variable.text); }
          }
        }
        return names;
      };
      for (const child of top) {
        if (child.type === 'import_statement') { continue; }
        if (child.type !== 'export_statement') { visitDeclaration(child, named(child).filter((entry) => entry.type === 'decorator')); continue; }
        const specifier = stringLiteralValue(child.childForFieldName('source'));
        if (specifier) { imports.push({ specifier, startLine: line(child) }); }
        const isDefault = child.children.some((entry) => entry?.type === 'default');
        const typeOnly = child.children.some((entry) => entry?.type === 'type');
        const declaration = child.childForFieldName('declaration') ?? child.childForFieldName('value');
        if (declaration) {
          const names = visitDeclaration(declaration, named(child).filter((entry) => entry.type === 'decorator'), true, isDefault);
          if (names.length) { names.forEach((name) => addExport(child, isDefault ? 'default' : name, name, null, typeOnly || ['interface_declaration', 'type_alias_declaration'].includes(declaration.type))); }
          else if (isDefault) { addExport(child, 'default', declaration.type === 'identifier' ? declaration.text : null); }
        }
        const clause = named(child).find((entry) => entry.type === 'export_clause');
        if (clause) {
          for (const entry of named(clause)) {
            const local = entry.childForFieldName('name')?.text;
            if (local) { addExport(entry, entry.childForFieldName('alias')?.text ?? local, local, specifier, typeOnly || entry.children.some((part) => part?.type === 'type')); }
          }
        } else if (specifier && !declaration) {
          const namespace = named(child).find((entry) => entry.type === 'namespace_export');
          addExport(child, namespace ? named(namespace)[0]?.text ?? '*' : '*', '*', specifier, typeOnly);
        }
      }
      // undefined = not a route chain; null = recognized chain with a dynamic path.
      const routeBase = (object: Node | null): string[] | null | undefined => {
        if (!object || object.type !== 'call_expression') { return undefined; }
        const method = object.childForFieldName('function');
        if (method?.type !== 'member_expression') { return undefined; }
        const receiver = method.childForFieldName('object');
        const property = method.childForFieldName('property')?.text;
        if (property === 'route' && routers.has(receiver?.text ?? '')) { return staticPaths(named(object.childForFieldName('arguments'))[0]); }
        return property && HTTP_METHODS.has(property) ? routeBase(receiver) : undefined;
      };
      const testCallName = (callee: Node | null): string | null => {
        if (!callee) { return null; }
        if (callee.type === 'identifier') { return TEST_FUNCTIONS.has(callee.text) ? callee.text : null; }
        if (callee.type === 'member_expression' && ['skip', 'only', 'todo', 'concurrent'].includes(callee.childForFieldName('property')?.text ?? '')) { return testCallName(callee.childForFieldName('object')); }
        if (callee.type === 'call_expression') {
          const fn = callee.childForFieldName('function');
          if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === 'each') { return testCallName(fn.childForFieldName('object')); }
        }
        return null;
      };
      const stack: Node[] = [tree.rootNode];
      while (stack.length) {
        const node = stack.pop()!;
        if (node.type === 'call_expression' || node.type === 'new_expression') {
          let callee = node.childForFieldName(node.type === 'new_expression' ? 'constructor' : 'function');
          if (callee?.type === 'member_expression') { callee = callee.childForFieldName('property'); }
          if (callee && ['identifier', 'property_identifier', 'type_identifier'].includes(callee.type)) {
            calls.push({ startLine: line(callee), startColumn: callee.startPosition.column,
              endLine: callee.endPosition.row + 1, endColumn: callee.endPosition.column });
          }
        }
        if (node.type === 'assignment_expression') {
          const left = node.childForFieldName('left')?.text ?? '';
          const value = node.childForFieldName('right');
          const match = /^(?:module\.exports|exports)\.([\w$]+)$/.exec(left);
          if (match) {
            addExport(node, match[1]!, value?.type === 'identifier' ? value.text : match[1]!);
            if (value && ['arrow_function', 'function_expression'].includes(value.type)) { addSymbol(value, match[1]!, 'function', callSignature(value)); }
          } else if (left === 'module.exports') {
            if (value?.type === 'object') {
              for (const entry of named(value)) {
                if (entry.type === 'shorthand_property_identifier') { addExport(entry, entry.text, entry.text); }
                else if (entry.type === 'pair') {
                  const key = entry.childForFieldName('key'); const target = entry.childForFieldName('value');
                  const name = stringLiteralValue(key) ?? key?.text;
                  if (name) {
                    addExport(entry, name, target?.type === 'identifier' ? target.text : name);
                    if (target && ['arrow_function', 'function_expression'].includes(target.type)) { addSymbol(target, name, 'function', callSignature(target)); }
                  }
                }
              }
            } else { addExport(node, 'default', value?.type === 'identifier' ? value.text : null); }
          }
        }
        if (node.type === 'call_expression') {
          const callee = node.childForFieldName('function');
          const args = named(node.childForFieldName('arguments'));
          if (callee?.text === 'require') {
            const specifier = stringLiteralValue(args[0]);
            if (specifier) { imports.push({ specifier, startLine: line(node) }); }
          }
          if (callee?.type === 'member_expression') {
            const object = callee.childForFieldName('object');
            const property = callee.childForFieldName('property')?.text ?? '';
            const chained = routeBase(object);
            if (HTTP_METHODS.has(property) && (routers.has(object?.text ?? '') || chained !== undefined)) {
              const routes = chained === undefined ? staticPaths(args[0]) : chained;
              if (routes === null) { diagnostics.push({ line: line(node), message: 'Dynamic Express route path; unresolved.' }); }
              for (const route of routes ?? []) {
                const handlers = chained === undefined ? args.slice(1) : args;
                const handler = handlers.at(-1);
                let handlerScope: 'module' | 'nested' = 'module';
                for (let parent = node.parent; parent && parent.type !== 'program'; parent = parent.parent) {
                  if (!['expression_statement', 'export_statement', 'call_expression', 'member_expression'].includes(parent.type)) { handlerScope = 'nested'; break; }
                }
                addSymbol(node, `${property.toUpperCase()} ${route}`, 'endpoint', null, null, node,
                  { framework: 'express', method: property.toUpperCase(), path: route, handler: handler?.type === 'identifier' ? handler.text : null,
                    ...(handler?.type === 'identifier' ? { handlerScope, handlerLocation: { startLine: line(handler), startColumn: handler.startPosition.column,
                      endLine: handler.endPosition.row + 1, endColumn: handler.endPosition.column } } : {}), scope: 'declared' });
              }
            }
          }
          if (isTestPath(path) && testCallName(callee)) {
            const name = stringLiteralValue(args[0]);
            if (name !== null) { tests.push({ name, startLine: line(node), endLine: node.endPosition.row + 1, span: span(node) }); }
          }
        }
        stack.push(...named(node).reverse());
      }
      symbols.sort((a, b) => a.startLine - b.startLine || (a.span?.startOffset ?? 0) - (b.span?.startOffset ?? 0));
      tests.sort((a, b) => a.startLine - b.startLine);
      const exportedNames = new Set(exports.filter((entry) => !entry.sourceModule && entry.localName).map((entry) => entry.localName!));
      return { symbols, imports, tests, exports, diagnostics, calls, inheritance, metrics: measureSyntax(tree.rootNode, false),
        typeUses: importedTypeUses(tree.rootNode, typedDeclarations, exportedNames) };
    } finally { tree.delete(); }
  } finally { parser.delete(); }
}

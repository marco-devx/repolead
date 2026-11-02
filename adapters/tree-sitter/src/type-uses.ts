import type { Node } from 'web-tree-sitter';

export interface TypedDeclaration { node: Node; name: string; kind: string; parent: string | null }
export interface ImportedTypeUse {
  source: string; declarationLine: number; specifier: string; imported: string; local: string;
  importLine: number; startLine: number; endLine: number; startColumn: number; endColumn: number;
  publicContract: boolean; expression: string;
}
interface Binding { specifier: string; imported: string; local: string; importLine: number; namespace: boolean }
const named = (node: Node | null | undefined): Node[] => (node?.namedChildren ?? []).filter((child): child is Node => child !== null);
const line = (node: Node) => node.startPosition.row + 1;

function bindings(root: Node, python: boolean): Map<string, Binding> {
  const result = new Map<string, Binding>();
  const add = (node: Node, specifier: string, imported: string, local: string, namespace = false) =>
    result.set(local, { specifier, imported, local, namespace, importLine: line(node) });
  for (const statement of named(root)) {
    if (python) {
      if (statement.type === 'import_from_statement') {
        const module = statement.childForFieldName('module_name');
        if (!module) { continue; }
        for (const entry of named(statement).filter((node) => node.id !== module.id)) {
          const imported = entry.type === 'aliased_import' ? entry.childForFieldName('name')?.text : entry.type === 'dotted_name' ? entry.text : null;
          if (imported) { add(statement, module.text, imported, entry.childForFieldName('alias')?.text ?? imported); }
        }
      } else if (statement.type === 'import_statement') {
        for (const entry of named(statement)) {
          const module = entry.type === 'aliased_import' ? entry.childForFieldName('name')?.text : entry.text;
          if (module) { add(statement, module, '*', entry.childForFieldName('alias')?.text ?? module, true); }
        }
      }
    } else if (statement.type === 'import_statement') {
      const specifier = statement.childForFieldName('source')?.text.slice(1, -1);
      if (!specifier) { continue; }
      const clause = named(statement).find((node) => node.type === 'import_clause');
      for (const entry of named(clause)) {
        if (entry.type === 'identifier') { add(statement, specifier, 'default', entry.text); }
        if (entry.type === 'namespace_import' && named(entry)[0]) { add(statement, specifier, '*', named(entry)[0]!.text, true); }
        if (entry.type === 'named_imports') {
          for (const item of named(entry)) {
            const imported = item.childForFieldName('name')?.text;
            if (imported) { add(statement, specifier, imported, item.childForFieldName('alias')?.text ?? imported); }
          }
        }
      }
    }
  }
  return result;
}

/** Direct imported names used in explicit annotations, never identifier regexes over a body. */
export function importedTypeUses(root: Node, declarations: TypedDeclaration[], exportedNames: ReadonlySet<string>, python = false): ImportedTypeUse[] {
  const imports = bindings(root, python);
  for (const declaration of declarations) {
    if (!declaration.parent && (python || ['class', 'interface', 'type'].includes(declaration.kind))) { imports.delete(declaration.name); }
  }
  const result: ImportedTypeUse[] = [];
  const callable = new Set(['function', 'method']);
  const declarationScopes = new Map(declarations.map((entry) => [entry.name, entry.node]));
  const genericNames = (node: Node | null) => named(node?.childForFieldName('type_parameters'))
    .map((parameter) => parameter.childForFieldName('name')?.text ?? (python ? parameter.text : '')).filter(Boolean);
  const privateMember = (node: Node) => named(node).some((child) => child.type === 'accessibility_modifier' && ['private', 'protected'].includes(child.text))
    || Boolean(node.childForFieldName('name')?.text.startsWith('#'));
  for (const declaration of declarations) {
    if (declaration.kind === 'endpoint' || declaration.node.hasError) { continue; }
    const ownerName = declaration.parent ?? declaration.name;
    const publicContract = exportedNames.has(ownerName) && !privateMember(declaration.node)
      && (!python || !declaration.name.split('.').at(-1)!.startsWith('_'));
    if (!publicContract) { continue; }
    const parent = declaration.parent ? declarationScopes.get(declaration.parent) ?? null : null;
    const shadowed = new Set([...genericNames(parent), ...genericNames(declaration.node), ...genericNames(declaration.node.childForFieldName('value'))]);
    const record = (node: Node, expression: string, bound: ReadonlySet<string>) => {
      const match = [...imports.values()].filter((binding) => expression === binding.local || expression.startsWith(`${binding.local}.`))
        .sort((a, b) => b.local.length - a.local.length)[0];
      if (!match || bound.has(match.local) || (match.namespace && expression === match.local)) { return; }
      const suffix = expression.slice(match.local.length).replace(/^\./, '');
      result.push({ source: declaration.name, declarationLine: line(declaration.node), specifier: match.specifier,
        imported: match.namespace ? suffix : [match.imported, suffix].filter(Boolean).join('.'), local: match.local,
        importLine: match.importLine, startLine: line(node), endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column, endColumn: node.endPosition.column, publicContract, expression });
    };
    const visit = (node: Node, bound: ReadonlySet<string>) => {
      const local = new Set([...bound, ...genericNames(node)]);
      if (['string', 'string_fragment', 'comment', 'literal_type'].includes(node.type)) { return; }
      if (python && node.type === 'attribute') { record(node, node.text, local); return; }
      if (!python && ['nested_type_identifier', 'member_expression'].includes(node.type)) { record(node, node.text, local); return; }
      if (node.type === (python ? 'identifier' : 'type_identifier') || (!python && node.type === 'identifier' && node.parent?.type === 'extends_clause')) {
        if (node.parent?.type === 'type_parameter' && node.parent.childForFieldName('name')?.id === node.id) { return; }
        record(node, node.text, local);
      }
      for (const child of named(node)) { visit(child, local); }
    };
    const annotations = (node: Node) => {
      // Traverse the signature but stop at executable bodies, values/defaults and decorators.
      if (['type_annotation', 'type'].includes(node.type)) { visit(node, shadowed); return; }
      for (const child of named(node)) {
        if (['body', 'value', 'default', 'right', 'decorator'].some((field) => node.childForFieldName(field)?.id === child.id) || child.type === 'decorator') { continue; }
        if (node.childForFieldName('return_type')?.id === child.id || child.type === 'type_parameters') { visit(child, shadowed); }
        else { annotations(child); }
      }
    };
    const node = declaration.node;
    if (callable.has(declaration.kind)) {
      const value = node.childForFieldName('value');
      annotations(value && ['arrow_function', 'function_expression'].includes(value.type) ? value : node);
    } else if (declaration.kind === 'type') {
      const value = node.childForFieldName('value');
      if (value) { visit(value, shadowed); }
    } else if (['class', 'interface'].includes(declaration.kind)) {
      for (const heritage of named(node).filter((child) => ['class_heritage', 'extends_type_clause', 'type_parameters', 'argument_list'].includes(child.type))) { visit(heritage, shadowed); }
      for (const field of named(node.childForFieldName('body'))) {
        if (['method_definition', 'method_signature', 'function_definition', 'decorated_definition'].includes(field.type) || privateMember(field)) { continue; }
        // Arrow members have their own extracted method; avoid duplicate ownership.
        if (['arrow_function', 'function_expression'].includes(field.childForFieldName('value')?.type ?? '')) { continue; }
        annotations(field);
      }
    } else { annotations(node); }
  }
  return result.sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn || a.source.localeCompare(b.source));
}

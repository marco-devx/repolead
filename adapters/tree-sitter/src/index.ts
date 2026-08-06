import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Language, Parser } from 'web-tree-sitter';

export type GrammarName = 'typescript' | 'tsx';

const require_ = createRequire(import.meta.url);

let runtimeReady: Promise<unknown> | null = null;
const languages = new Map<GrammarName, Language>();

function grammarWasmPath(name: GrammarName): string {
  const packageRoot = dirname(require_.resolve('@vscode/tree-sitter-wasm/package.json'));
  return join(packageRoot, 'wasm', `tree-sitter-${name}.wasm`);
}

export async function loadLanguage(name: GrammarName): Promise<Language> {
  runtimeReady ??= Parser.init();
  await runtimeReady;
  let language = languages.get(name);
  if (!language) {
    language = await Language.load(grammarWasmPath(name));
    languages.set(name, language);
  }
  return language;
}

export async function createParser(name: GrammarName): Promise<Parser> {
  const language = await loadLanguage(name);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

export type { Language, Node, Parser, Tree } from 'web-tree-sitter';

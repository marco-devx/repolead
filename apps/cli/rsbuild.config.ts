import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: {
      index: './src/index.ts',
    },
  },
  output: {
    target: 'node',
    distPath: {
      root: 'dist',
    },
    filename: {
      js: '[name].cjs',
    },
    // Módulos con binarios nativos o wasm cargado por ruta: se resuelven
    // desde node_modules en runtime, no se bundlean.
    externals: [
      'better-sqlite3',
      'web-tree-sitter',
      '@vscode/tree-sitter-wasm',
      '@anthropic-ai/claude-agent-sdk',
    ],
  },
});

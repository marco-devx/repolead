import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DUPLICATE_SOURCE = `export function compute(n: number) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      total += i * 3;
    } else {
      total -= i;
    }
  }
  return total;
}
`;

export function qualityFixture(configured = false) {
  const root = mkdtempSync(join(tmpdir(), 'repolead-quality-fixture-'));
  const write = (path: string, source: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  write('src/one.ts', DUPLICATE_SOURCE);
  write('src/two.ts', DUPLICATE_SOURCE.replace('compute', 'other'));
  write('src/handling.ts', 'export function bad() { try { perform(); } catch (error) {} }\nexport function good() { try { perform(); } catch (error) { throw error; } }\n');
  write('src/complex.ts', `export function complex(n: number) {\n${Array.from({ length: 16 }, (_, index) => `  if (n === ${index}) return ${index};`).join('\n')}\n  return -1;\n}\n`);
  write('domain/store.ts', "import { PrismaClient } from '@prisma/client';\nexport const database = new PrismaClient();\n");
  write('calc.py', 'import os\n\ndef compute(n):\n    if n and n > 2:\n        return n\n    return missing\n');
  write('.gitignore', '.repolead/\ncoverage/\n');
  if (configured) { write('.repolead.yaml', 'version: 1\nmetrics:\n  tools: [jscpd, ruff, radon]\n  coverage: coverage/lcov.info\n'); }
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Quality fixture');
  git('add', '.'); git('commit', '-m', 'Quality fixture');
  write('coverage/lcov.info', 'TN:fixture\nSF:src/one.ts\nDA:2,1\nDA:3,1\nDA:4,0\nBRDA:4,0,0,1\nBRDA:4,0,1,0\nLF:3\nLH:2\nBRF:2\nBRH:1\nend_of_record\n');
  return { root, write, git };
}

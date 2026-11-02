import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function createChainFixture() {
  const root = mkdtempSync(join(tmpdir(), 'repolead-analysis-chain-'));
  const sources = {
    'src/leaf/price.ts': 'export function price(value: number) { return value * 2; }\nexport function untouched() { return 7; }\n',
    'src/wrapper/invoice.ts': "import { price } from '../leaf/price';\nexport function invoice(value: number) { return price(value); }\n",
    'src/consumer/checkout.ts': "import { invoice } from '../wrapper/invoice';\nexport function checkout(value: number) { return invoice(value); }\n",
    'src/unrelated/format.ts': 'export function format(value: number) { return String(value); }\n',
    'src/public/index.ts': "export { checkout } from '../consumer/checkout';\n",
    'src/start.ts': "import { checkout } from './consumer/checkout';\nconsole.log(checkout(10));\n",
    'config/runtime.json': '{"retryLimit":3,"featureFlags":{"invoices":true}}\n',
    'docs/invoices.md': '# Invoices\nInvoices use the price calculation.\n[Implementation](../src/wrapper/invoice.ts#L2)\n',
    'docs/support.md': '# Support\nCustomers contact the support team by email.\n',
    'package.json': '{"name":"incremental-chain"}\n',
    'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"},"include":["src"]}\n',
    '.repolead.yaml': 'version: 1\nmodules:\n  - {name: leaf, path: src/leaf}\n  - {name: wrapper, path: src/wrapper}\n  - {name: consumer, path: src/consumer}\n  - {name: unrelated, path: src/unrelated}\n  - {name: public, path: src/public}\nanalysis_budget:\n  max_reanalysis_depth: 1\n',
    '.gitignore': '.repolead/\n',
  };
  for (const [path, content] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'RepoLead acceptance'); git('config', 'user.email', 'acceptance@example.invalid');
  git('add', '.'); git('commit', '-m', 'Dependency and product acceptance fixture');
  return { root, sources, git };
}

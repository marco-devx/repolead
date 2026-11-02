import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function policyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'repolead-policy-'));
  const write = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  write('.gitignore', '.repolead/\n');
  write('.repolead.yaml', `metrics:
  tools: [jscpd, ruff]
modules:
  - {name: sales, path: cycles/sales}
  - {name: billing, path: cycles/billing}
  - {name: inventory, path: cycles/inventory}
  - {name: types-left, path: types/left}
  - {name: types-right, path: types/right}
`);
  for (const [from, to] of [['sales', 'billing'], ['billing', 'inventory'], ['inventory', 'sales']]) {
    write(`cycles/${from}/index.ts`, `import { ${to} } from '../${to}/index';\nexport function ${from}(n: number): number { return n > 0 ? ${to}(n - 1) : 0; }\n`);
  }
  write('types/left/index.ts', "import type { Right } from '../right/index';\nexport interface Left { next?: Right; }\n");
  write('types/right/index.ts', "import type { Left } from '../left/index';\nexport interface Right { next?: Left; }\n");
  write('domain/invoice.ts', `import { PrismaClient } from '@prisma/client';
// A domain entity performs its own persistence on every business operation.
export class Invoice {
  private database = new PrismaClient();
  async approve(id: string) { return this.database.invoice.update({where: {id}, data: {status: 'approved'}}); }
}
`);
  write('domain/database.test.ts', `import type { PrismaClient } from '@prisma/client';
// Test-only fixture: no database construction, query, or production API.
export function databaseStub(client: PrismaClient) { return client; }
`);
  write('domain/checkout.ts', `import type { Request as HttpRequest, Response as HttpResponse } from 'express';
export interface CheckoutPolicy {
  // Business authorization port exported for all implementations; tied to HTTP.
  authorize(request: HttpRequest): HttpResponse;
}
`);
  write('domain/request.test.ts', `import type { Request } from 'express';
// Test-only request builder for the HTTP integration fixture.
export function requestFixture(request: Request): Request { return request; }
`);
  write('domain/unused.ts', `import type { Request } from 'express';
export function label() { const text = 'Request'; return text; }
function privateHelper(value: Request): Request { return value; }
`);
  write('src/payment.ts', `export async function capturePayment(gateway: any, order: any) {
  try {
    await gateway.charge(order.card, order.total);
  } catch (error) {
  }
  order.status = 'paid';
  return {success: true};
}
`);
  write('src/cleanup.ts', `import { unlink } from 'node:fs/promises';
// Cleanup is explicitly best-effort. Absence or failure must never fail the completed operation.
export async function cleanupOptionalTempFile(path: string) {
  try { await unlink(path); } catch (error) { /* deliberately ignore optional cleanup failure */ }
}
`);
  write('src/order-total.py', 'def order_total(items):\n    return subtotal + sum(items)\n');
  write('src/clean.py', 'def order_total(items):\n    return sum(items)\n');
  const duplicate = `export function calculateOrderTotal(items: any[], customer: any) {
  // The shared checkout pricing rule: tax and loyalty discount must stay identical across entry points.
  let subtotal = 0;
  for (const item of items) {
    if (item.quantity <= 0) throw new Error('Invalid quantity');
    subtotal += item.price * item.quantity;
  }
  const discount = customer.loyaltyLevel >= 3 ? subtotal * 0.1 : 0;
  const discounted = subtotal - discount;
  const tax = Math.round(discounted * 0.18 * 100) / 100;
  return { subtotal, discount, tax, total: discounted + tax };
}
`;
  write('src/order-pricing.ts', duplicate);
  write('src/checkout-pricing.ts', duplicate.replace('calculateOrderTotal', 'calculateCheckoutTotal'));
  const fixtureClone = `export function historicalParserFixture(values: number[]) {
  // Frozen compatibility fixture; keep this independently versioned test sample unchanged.
  const output = [];
  for (const value of values) {
    if (value === 0) { output.push('zero'); }
    else if (value < 0) { output.push('negative'); }
    else { output.push('positive'); }
  }
  return output.join(',');
}
`;
  write('fixtures/compat-v1.ts', fixtureClone);
  write('fixtures/compat-v2.ts', fixtureClone);
  write('src/complex.ts', `export function mutateOrder(order: any, customer: any, inventory: any, payment: any) {
  // This function mixes discount policy, inventory mutation, authorization and payment retry state.
  let total = 0;
  if (customer.active) {
    for (const item of order.items) {
      if (item.quantity > 0) {
        if (inventory[item.id] >= item.quantity) {
          if (customer.vip) {
            if (order.country === 'PE') { total += item.price * 0.8; inventory[item.id] -= item.quantity; }
            else if (item.imported) { total += item.price * 1.1; order.manualReview = true; }
            else { total += item.price; }
          } else if (customer.credit > 0) {
            if (customer.credit > item.price) { customer.credit -= item.price; }
            else { total += item.price - customer.credit; customer.credit = 0; }
          } else { total += item.price; }
          if (item.fragile) { if (order.express) total += 15; else total += 5; }
        } else if (order.allowBackorder) { inventory[item.id] = -item.quantity; }
        else { order.rejected.push(item.id); }
      } else { order.invalid = true; }
    }
    if (!order.invalid) {
      if (payment.available) {
        try { payment.capture(total); } catch (error) {
          if (customer.vip) { order.retry = true; } else { order.failed = true; }
        }
      } else if (order.cash) { order.pending = true; }
      else { order.failed = true; }
    }
  } else { order.blocked = true; }
  return total;
}
`);
  write('src/dispatch.ts', `// Explicit protocol decoder: independent constants, no side effects or nested responsibilities.
export function decodeProtocolTag(tag: number): string {
  switch (tag) {
${Array.from({ length: 16 }, (_, index) => `    case ${index}: return 'TAG_${index}';`).join('\n')}
    default: throw new Error('Unknown protocol tag');
  }
}
`);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.name', 'Policy acceptance'); git('config', 'user.email', 'policy@example.invalid');
  git('add', '.'); git('commit', '-m', 'Known policy positives and legitimate counterexamples');
  return { root, write, git };
}

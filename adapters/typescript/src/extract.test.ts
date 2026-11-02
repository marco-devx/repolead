import { expect, test } from '@rstest/core';

import { extractFromSource, isTestPath } from './extract';

test('public imported type uses follow aliases/namespaces and exclude bodies, strings, private and shadowed types', async () => {
  const source = `import type { Request as Req, Response as Res } from 'express';
import * as http from 'express';
interface Internal { handle(req: Req): Res; }
export interface Port { handle(req: Req): Res; incoming: http.Request; }
export function accept(value: Req): Res { return {} as Res; }
export function generic<Req>(value: Req): Req { return value; }
export const genericArrow = <Req>(value: Req): Req => value;
export type Literal = 'Req';
export class Service<Req> {
  private hidden(value: Res): Res { return value; }
  private cached: Res;
  run(value: Req): http.Response { return {} as http.Response; }
}
function helper(value: Req): Res { return {} as Res; }
export function words() { const Req = 'Res'; return Req; }
`;
  const extraction = await extractFromSource('domain/port.ts', source);
  expect(extraction.typeUses?.map((use) => [use.source, use.expression, use.imported])).toEqual([
    ['Port.handle', 'Req', 'Request'], ['Port.handle', 'Res', 'Response'], ['Port', 'http.Request', 'Request'],
    ['accept', 'Req', 'Request'], ['accept', 'Res', 'Response'], ['Service.run', 'http.Response', 'Response'],
  ]);
  for (const use of extraction.typeUses ?? []) {
    expect(use.publicContract).toBe(true);
    expect(source.split('\n')[use.startLine - 1]!.slice(use.startColumn, use.endColumn)).toBe(use.expression);
  }
});

const FIXTURE = `
import { Repo } from './repo';
import express from 'express';

export interface PaymentRepository {
  save(payment: Payment): Promise<void>;
}

export class PaymentService {
  constructor(private readonly repo: PaymentRepository) {}

  process(command: CreatePaymentCommand): Payment {
    return this.repo.save(command);
  }

  handle = (event: PaymentEvent): void => {};
}

export function createService(repo: PaymentRepository): PaymentService {
  return new PaymentService(repo);
}

export const mapPayment = (row: Row): Payment => ({ id: row.id });

export type PaymentId = string;

const app = express();
app.post('/payments', (req, res) => res.send('ok'));
`;

test('extrae clases, métodos, interfaces, funciones, tipos y endpoints', async () => {
  const { symbols, imports } = await extractFromSource('src/payment/service.ts', FIXTURE);
  const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));

  expect(byName.get('PaymentService')?.kind).toBe('class');
  expect(byName.get('PaymentService.process')?.kind).toBe('method');
  expect(byName.get('PaymentService.process')?.parent).toBe('PaymentService');
  expect(byName.get('PaymentService.process')?.signature).toContain('CreatePaymentCommand');
  expect(byName.get('PaymentService.handle')?.kind).toBe('method');
  expect(byName.get('PaymentRepository')?.kind).toBe('interface');
  expect(byName.get('createService')?.kind).toBe('function');
  expect(byName.get('mapPayment')?.kind).toBe('function');
  expect(byName.get('PaymentId')?.kind).toBe('type');
  expect(byName.get('POST /payments')?.kind).toBe('endpoint');

  const service = byName.get('PaymentService');
  expect(service?.startLine).toBeGreaterThan(0);
  expect(service?.endLine).toBeGreaterThan(service?.startLine ?? 0);

  expect(imports.map((entry) => entry.specifier)).toEqual(['./repo', 'express']);
});

test('extrae nombres de tests de archivos de test', async () => {
  const source = `
import { test, expect } from '@rstest/core';
import { createService } from './service';

test('procesa un pago', () => {});
it('maneja errores', () => {});
`;
  const { tests } = await extractFromSource('src/payment/service.test.ts', source);
  expect(tests.map((entry) => entry.name)).toEqual(['procesa un pago', 'maneja errores']);
});

test('member visibility and named route argument locations retain scope instead of inferring access from signatures', async () => {
  const source = `export class Service {
  run() {}
  private hidden() {}
  protected extend() {}
  #secret() {}
  private closure = () => 1;
}
function handler() {}
router.get('/global', handler);
function install(handler: () => void) { router.get('/nested', handler); }
`;
  const result = await extractFromSource('src/visibility.ts', source);
  expect(Object.fromEntries(result.symbols.filter((symbol) => symbol.kind === 'method').map((symbol) => [symbol.qualifiedName, symbol.visibility])))
    .toEqual({ 'Service.run': 'public', 'Service.hidden': 'private', 'Service.extend': 'protected', 'Service.#secret': 'private', 'Service.closure': 'private' });
  const global = result.symbols.find((symbol) => symbol.qualifiedName === 'GET /global')!.route!;
  const nested = result.symbols.find((symbol) => symbol.qualifiedName === 'GET /nested')!.route!;
  expect(global.handlerScope).toBe('module'); expect(nested.handlerScope).toBe('nested');
  const location = nested.handlerLocation!;
  expect(source.split('\n')[location.startLine - 1]!.slice(location.startColumn, location.endColumn)).toBe('handler');
});

test('isTestPath reconoce convenciones de test', () => {
  expect(isTestPath('src/a.test.ts')).toBe(true);
  expect(isTestPath('src/a.spec.tsx')).toBe(true);
  expect(isTestPath('src/a.ts')).toBe(false);
});

test('exports preserve aliases, type-only declarations, reexports, namespace and CommonJS bindings', async () => {
  const source = `export const limit = 10;
export interface Contract { save(): void; }
export function run() {}
export { run as execute };
export type { Contract as Port };
export { save as persist } from './storage';
export * from './models';
export * as util from './util';
export default function () { return limit; }
const local = () => 1;
exports.local = local;
module.exports = { alias: local };
`;
  const result = await extractFromSource('src/index.ts', source);
  expect(result.exports?.map((entry) => [entry.exportedName, entry.localName, entry.sourceModule, entry.typeOnly])).toEqual([
    ['limit', 'limit', null, false], ['Contract', 'Contract', null, true], ['run', 'run', null, false],
    ['execute', 'run', null, false], ['Port', 'Contract', null, true], ['persist', 'save', './storage', false],
    ['*', '*', './models', false], ['util', '*', './util', false], ['default', 'default', null, false],
    ['local', 'local', null, false], ['alias', 'local', null, false],
  ]);
  expect(result.symbols.find((symbol) => symbol.qualifiedName === 'limit')?.kind).toBe('variable');
  expect(result.symbols.find((symbol) => symbol.qualifiedName === 'Contract.save')?.kind).toBe('method');
  expect(result.symbols.find((symbol) => symbol.qualifiedName === 'default')?.kind).toBe('function');
});

test('Nest literal controller prefixes, decorator aliases and handler links are explicit; dynamic paths are diagnosed', async () => {
  const source = `import { Controller as C, Get as Read, Post } from '@nestjs/common';
import * as nest from '@nestjs/common';
@C('orders')
export class OrdersController {
  @Read(':id')
  find(id: string) { return id; }
  @Post()
  create() { return 'created'; }
  @Read(dynamicPath)
  dynamic() {}
}
@nest.Controller({ path: ['users', 'people'] })
class Users {
  @nest.Get()
  all() { return []; }
}
function Get() {}
@Get()
class NotNest { method() {} }
`;
  const result = await extractFromSource('src/controllers.ts', source);
  const routes = result.symbols.filter((symbol) => symbol.kind === 'endpoint');
  expect(routes.map((route) => route.qualifiedName)).toEqual(['GET /orders/:id', 'POST /orders', 'GET /users', 'GET /people']);
  expect(routes[0]?.route).toEqual({ framework: 'nest', method: 'GET', path: '/orders/:id', handler: 'OrdersController.find', scope: 'declared' });
  expect(source.slice(routes[0]!.span!.startOffset, routes[0]!.span!.endOffset)).toContain("@Read(':id')");
  expect(source.slice(routes[0]!.span!.startOffset, routes[0]!.span!.endOffset)).toContain('return id;');
  expect(result.diagnostics?.[0]?.message).toContain('Dynamic Nest route');
});

test('Express factory aliases, chained routes and exact Unicode spans do not absorb neighboring functions', async () => {
  const source = `import { Router as NewRouter } from 'express';
const routes = NewRouter();
function find() { return '🧠'; } function save() { return 'saved'; }
routes.route('/users').get(find).post(save);
routes.options('/users', find);
routes.patch(dynamicPath, save);
routes.route(dynamicPath).get(find).post(save);
`;
  const result = await extractFromSource('src/routes.ts', source);
  const endpoints = result.symbols.filter((symbol) => symbol.kind === 'endpoint');
  expect(endpoints.map((symbol) => symbol.qualifiedName).sort()).toEqual(['GET /users', 'OPTIONS /users', 'POST /users']);
  expect(endpoints.find((symbol) => symbol.route?.method === 'POST')?.route?.handler).toBe('save');
  for (const name of ['find', 'save']) {
    const symbol = result.symbols.find((entry) => entry.qualifiedName === name)!;
    const text = source.slice(symbol.span!.startOffset, symbol.span!.endOffset);
    expect(text.startsWith(`function ${name}()`)).toBe(true);
    expect(text.includes(`function ${name === 'find' ? 'save' : 'find'}()`)).toBe(false);
  }
  expect(result.diagnostics?.filter((entry) => entry.message.includes('Dynamic Express'))).toHaveLength(3);
});

test('test.only/skip/each retain complete test spans and ordinary production test calls are not test cases', async () => {
  const source = `test.only('validates permission', () => { expect(allowed()).toBe(true); });
it.skip('handles timeout', () => {});
test.each([1, 2])('case %s', (value) => { expect(value).toBeGreaterThan(0); });`;
  const result = await extractFromSource('src/service.test.ts', source);
  expect(result.tests.map((entry) => entry.name)).toEqual(['validates permission', 'handles timeout', 'case %s']);
  expect(source.slice(result.tests[0]!.span!.startOffset, result.tests[0]!.span!.endOffset)).toContain('expect(allowed())');
  expect((await extractFromSource('src/service.ts', source)).tests).toEqual([]);
});

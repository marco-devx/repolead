import { expect, test } from '@rstest/core';

import { extractFromSource, isTestPath } from './extract';

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

test('isTestPath reconoce convenciones de test', () => {
  expect(isTestPath('src/a.test.ts')).toBe(true);
  expect(isTestPath('src/a.spec.tsx')).toBe(true);
  expect(isTestPath('src/a.ts')).toBe(false);
});

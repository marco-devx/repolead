import { expect, test } from '@rstest/core';

import { contentHash, fileUri, stableRepositoryId, stableSymbolId, symbolUri } from './ids';

const identity = {
  repository: 'payments-api',
  path: 'src/payment/service.ts',
  kind: 'method',
  qualifiedName: 'PaymentService.process',
  signature: '(command: CreatePaymentCommand): Payment',
} as const;

test('stableSymbolId es determinístico y no depende de líneas', () => {
  expect(stableSymbolId(identity)).toBe(stableSymbolId({ ...identity }));
  expect(stableSymbolId(identity)).toMatch(/^sym_[0-9a-f]{32}$/);
});

test('cambiar la firma cambia la identidad del símbolo', () => {
  const changed = stableSymbolId({ ...identity, signature: '(command: CreatePaymentCommand): Promise<Payment>' });
  expect(changed).not.toBe(stableSymbolId(identity));
});

test('las rutas se normalizan antes de construir la identidad', () => {
  expect(stableSymbolId({ ...identity, path: './src/payment/service.ts' })).toBe(stableSymbolId(identity));
  expect(fileUri('payments-api', './src/a.ts')).toBe('repo://payments-api/src/a.ts');
  expect(symbolUri('payments-api', 'src/a.ts', 'A.b')).toBe('symbol://payments-api/src/a.ts#A.b');
});

test('stableRepositoryId y contentHash son estables', () => {
  expect(stableRepositoryId('payments-api')).toBe(stableRepositoryId('payments-api'));
  expect(stableRepositoryId('payments-api')).toMatch(/^repo_[0-9a-f]{16}$/);
  expect(contentHash('abc')).toBe(contentHash('abc'));
  expect(contentHash('abc')).not.toBe(contentHash('abd'));
});

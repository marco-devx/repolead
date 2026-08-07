import { expect, test } from '@rstest/core';

import { extractPythonSource, isPythonTestPath, resolvePythonImport } from './extract';

const FIXTURE = `
from fastapi import APIRouter
from app.services.auth import verify_token
from .models import Payment

router = APIRouter()


class PaymentService:
    def process(self, command: dict) -> Payment:
        return save(command)

    @staticmethod
    def validate(command: dict) -> bool:
        return True


@router.get("/payments/{payment_id}")
def get_payment(payment_id: int) -> Payment:
    return find(payment_id)


@router.post("/payments")
async def create_payment(body: dict):
    return PaymentService().process(body)


def helper(x):
    return x
`;

test('extrae clases, métodos, funciones y endpoints FastAPI', async () => {
  const { symbols, imports } = await extractPythonSource('app/api/payments.py', FIXTURE);
  const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));

  expect(byName.get('PaymentService')?.kind).toBe('class');
  expect(byName.get('PaymentService.process')?.kind).toBe('method');
  expect(byName.get('PaymentService.process')?.parent).toBe('PaymentService');
  expect(byName.get('PaymentService.process')?.signature).toContain('-> Payment');
  expect(byName.get('PaymentService.validate')?.kind).toBe('method');
  expect(byName.get('GET /payments/{payment_id}')?.kind).toBe('endpoint');
  expect(byName.get('POST /payments')?.kind).toBe('endpoint');
  expect(byName.get('get_payment')?.kind).toBe('function');
  expect(byName.get('helper')?.kind).toBe('function');

  expect(imports.map((entry) => entry.specifier)).toEqual([
    'fastapi',
    'app.services.auth',
    '.models',
  ]);
});

test('extrae tests pytest de archivos test_*.py', async () => {
  const source = `
from app.api.payments import get_payment


def test_get_payment_ok():
    assert get_payment(1)


def test_get_payment_missing():
    assert get_payment(0) is None


def build_fixture():
    return {}
`;
  const { tests } = await extractPythonSource('tests/test_payments.py', source);
  expect(tests.map((entry) => entry.name)).toEqual(['test_get_payment_ok', 'test_get_payment_missing']);
});

test('isPythonTestPath y resolvePythonImport', () => {
  expect(isPythonTestPath('tests/test_payments.py')).toBe(true);
  expect(isPythonTestPath('app/payments_test.py')).toBe(true);
  expect(isPythonTestPath('app/payments.py')).toBe(false);

  const tracked = new Set([
    'app/services/auth.py',
    'app/models/__init__.py',
    'app/api/payments.py',
    'src/core/config.py',
  ]);
  expect(resolvePythonImport('app/api/payments.py', 'app.services.auth', tracked)).toBe('app/services/auth.py');
  expect(resolvePythonImport('app/api/payments.py', 'app.models', tracked)).toBe('app/models/__init__.py');
  expect(resolvePythonImport('app/api/payments.py', '.payments', tracked)).toBe('app/api/payments.py');
  expect(resolvePythonImport('app/api/payments.py', '..models', tracked)).toBe('app/models/__init__.py');
  expect(resolvePythonImport('app/api/payments.py', 'core.config', tracked)).toBe('src/core/config.py');
  expect(resolvePythonImport('app/api/payments.py', 'fastapi', tracked)).toBe(null);
});

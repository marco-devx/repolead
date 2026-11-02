import { expect, test } from '@rstest/core';

import { extractPythonSource, isPythonTestPath, resolvePythonImport } from './extract';

test('Python public annotations map imported aliases and namespace names, excluding helpers and rebound names', async () => {
  const source = `from fastapi import Request as Req
import starlette.requests as http
__all__ = ['Port', 'accept']
class Port:
    def handle(self, value: Req) -> http.Request:
        return value
    def _helper(self, value: Req) -> Req:
        return value
def accept(value: Req) -> Req:
    return value
def helper(value: Req) -> Req:
    return value
`;
  const extraction = await extractPythonSource('domain/port.py', source);
  expect(extraction.typeUses?.map((use) => [use.source, use.specifier, use.imported])).toEqual([
    ['Port.handle', 'fastapi', 'Request'], ['Port.handle', 'starlette.requests', 'Request'],
    ['accept', 'fastapi', 'Request'], ['accept', 'fastapi', 'Request'],
  ]);
  const rebound = await extractPythonSource('domain/other.py', 'from fastapi import Request\nclass Request:\n    pass\ndef accept(value: Request) -> Request:\n    return value\n');
  expect(rebound.typeUses).toEqual([]);
});

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

test('decorated Python functions, methods, endpoints and classes retain their complete body ranges', async () => {
  const source = `@dataclass
class Invoice:
    amount: float

    @property
    def total(self):
        return self.amount * 1.18

@router.post("/refunds")
@requires_permission("refund")
def refund(invoice):
    gateway.refund(invoice)
    return {"success": True}
`;
  const { symbols } = await extractPythonSource('app/invoice.py', source);
  const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
  expect(byName.get('Invoice')?.startLine).toBe(1);
  expect(byName.get('Invoice')?.endLine).toBe(7);
  expect(byName.get('Invoice.total')?.startLine).toBe(5);
  expect(byName.get('Invoice.total')?.endLine).toBe(7);
  expect(byName.get('refund')?.startLine).toBe(9);
  expect(byName.get('refund')?.endLine).toBe(13);
  expect(byName.get('POST /refunds')?.startLine).toBe(9);
  expect(byName.get('POST /refunds')?.endLine).toBe(13);
});

test('Python public declarations and literal __all__ expose export facts without inventing dynamic names', async () => {
  const source = `__all__ = ['Public', '_internal']
class Public:
    pass

def _internal():
    return True

def unexported():
    return False
`;
  const extraction = await extractPythonSource('module.py', source);
  expect(extraction.exports?.map((entry) => entry.exportedName)).toEqual(['Public', '_internal']);
  const dynamic = await extractPythonSource('module.py', '__all__ = build_names()\ndef public():\n    return True\n');
  expect(dynamic.diagnostics?.some((entry) => entry.message.includes('Dynamic Python __all__'))).toBe(true);
});

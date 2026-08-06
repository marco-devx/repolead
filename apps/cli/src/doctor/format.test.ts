import { expect, test } from '@rstest/core';

import type { DoctorResult } from './checks';
import { formatDoctorReport } from './format';

const ok = (name: string, required = true): DoctorResult => ({
  name,
  ok: true,
  required,
  detail: 'v1.0.0',
});

test('reporta entorno completo cuando todo pasa', () => {
  const report = formatDoctorReport([ok('bun'), ok('git')]);

  expect(report.healthy).toBe(true);
  expect(report.text).toContain('✓ bun');
  expect(report.text).toContain('Entorno completo.');
});

test('un check opcional fallido no rompe el entorno pero muestra el hint', () => {
  const report = formatDoctorReport([
    ok('git'),
    { name: 'qdrant', ok: false, required: false, detail: 'inaccesible', hint: 'docker compose up -d qdrant' },
  ]);

  expect(report.healthy).toBe(true);
  expect(report.text).toContain('− qdrant');
  expect(report.text).toContain('↳ docker compose up -d qdrant');
  expect(report.text).toContain('1 dependencia(s) opcional(es)');
});

test('un check requerido fallido marca el entorno como no saludable', () => {
  const report = formatDoctorReport([
    { name: 'git', ok: false, required: true, detail: 'no encontrado', hint: 'instala git' },
    ok('bun'),
  ]);

  expect(report.healthy).toBe(false);
  expect(report.text).toContain('✗ git');
  expect(report.text).toContain('Faltan 1 dependencia(s) requerida(s).');
});

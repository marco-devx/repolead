import type { DoctorResult } from './checks';

export interface DoctorReport {
  text: string;
  healthy: boolean;
}

export function formatDoctorReport(results: DoctorResult[]): DoctorReport {
  const width = Math.max(...results.map((result) => result.name.length));

  const lines = results.map((result) => {
    const mark = result.ok ? '✓' : result.required ? '✗' : '−';
    const line = `${mark} ${result.name.padEnd(width)}  ${result.detail}`;
    return !result.ok && result.hint ? `${line}\n  ↳ ${result.hint}` : line;
  });

  const missingRequired = results.filter((result) => !result.ok && result.required);
  const missingOptional = results.filter((result) => !result.ok && !result.required);
  const healthy = missingRequired.length === 0;

  const summary = healthy
    ? missingOptional.length === 0
      ? 'Entorno completo.'
      : `Entorno listo. ${missingOptional.length} dependencia(s) opcional(es) pendiente(s).`
    : `Faltan ${missingRequired.length} dependencia(s) requerida(s).`;

  return {
    text: [...lines, '', summary].join('\n'),
    healthy,
  };
}

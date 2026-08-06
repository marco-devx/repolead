import type { Command } from 'commander';

import { runDoctorChecks } from '../doctor/checks';
import { formatDoctorReport } from '../doctor/format';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Verifica los binarios y servicios que RepoLead necesita')
    .action(async () => {
      const results = await runDoctorChecks();
      const report = formatDoctorReport(results);
      console.log(report.text);
      if (!report.healthy) {
        process.exitCode = 1;
      }
    });
}

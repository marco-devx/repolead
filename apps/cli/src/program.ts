import { Command } from 'commander';

import { registerAnalyze } from './commands/analyze';
import { registerDoctor } from './commands/doctor';
import { registerQuery, registerReindex } from './commands/query';
import { registerScan } from './commands/scan';
import { registerStubCommands } from './commands/stubs';

export function buildProgram(): Command {
  const program = new Command('repolead')
    .description('Sistema de inteligencia del repositorio: análisis determinístico + Tech Lead agent + MCP')
    .version('0.1.0');

  registerScan(program);
  registerAnalyze(program);
  registerQuery(program);
  registerReindex(program);
  registerStubCommands(program);
  registerDoctor(program);

  return program;
}

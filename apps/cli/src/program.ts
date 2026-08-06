import { Command } from 'commander';

import { registerDoctor } from './commands/doctor';
import { registerStubCommands } from './commands/stubs';

export function buildProgram(): Command {
  const program = new Command('repolead')
    .description('Sistema de inteligencia del repositorio: análisis determinístico + Tech Lead agent + MCP')
    .version('0.1.0');

  registerStubCommands(program);
  registerDoctor(program);

  return program;
}

import { Command } from 'commander';

import { registerAnalyze } from './commands/analyze';
import { registerContext } from './commands/context';
import { registerAudit } from './commands/audit';
import { registerBrief } from './commands/brief';
import { registerOnboard } from './commands/onboard';
import { registerDoctor } from './commands/doctor';
import { registerInstallHooks } from './commands/install-hooks';
import { registerQuery, registerReindex } from './commands/query';
import { registerRefresh } from './commands/refresh';
import { registerScan } from './commands/scan';
import { registerServe } from './commands/serve';

export function buildProgram(): Command {
  const program = new Command('repolead')
    .description('Sistema de inteligencia del repositorio: análisis determinístico + Tech Lead agent + MCP')
    .version('0.1.0');

  registerScan(program);
  registerContext(program);
  registerOnboard(program);
  registerRefresh(program);
  registerAnalyze(program);
  registerAudit(program);
  registerBrief(program);
  registerQuery(program);
  registerReindex(program);
  registerServe(program);
  registerInstallHooks(program);
  registerDoctor(program);

  return program;
}

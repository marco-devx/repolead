import type { Command } from 'commander';

interface StubSpec {
  name: string;
  description: string;
  phase: string;
}

const STUBS: StubSpec[] = [
  { name: 'refresh', description: 'Actualiza el índice incrementalmente a partir del git diff', phase: 'Fase 8' },
];

export function registerStubCommands(program: Command): void {
  for (const stub of STUBS) {
    program
      .command(stub.name)
      .description(`${stub.description} (pendiente: ${stub.phase})`)
      .action(() => {
        console.error(`repolead ${stub.name}: aún no implementado — llega en la ${stub.phase}.`);
        process.exitCode = 1;
      });
  }
}

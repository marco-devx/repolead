import { expect, test } from '@rstest/core';

import { buildProgram } from './program';

test('el CLI registra los cinco comandos de la Fase 0', () => {
  const names = buildProgram()
    .commands.map((command) => command.name())
    .sort();

  expect(names).toEqual(['doctor', 'query', 'refresh', 'scan', 'serve']);
});

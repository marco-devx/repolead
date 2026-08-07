import { expect, test } from '@rstest/core';

import { buildProgram } from './program';

test('el CLI registra todos los comandos', () => {
  const names = buildProgram()
    .commands.map((command) => command.name())
    .sort();

  expect(names).toEqual(['analyze', 'audit', 'brief', 'doctor', 'install-hooks', 'onboard', 'query', 'refresh', 'reindex', 'scan', 'serve']);
});

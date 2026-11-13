import { expect, test } from '@rstest/core';

import { buildProgram } from './program';

test('el CLI registra todos los comandos', () => {
  const names = buildProgram()
    .commands.map((command) => command.name())
    .sort();

  expect(names).toEqual(['analyze', 'audit', 'benchmark-tokens', 'brief', 'cloud', 'context', 'dataflow', 'doctor', 'hotspots', 'impact', 'install-hooks', 'metrics', 'mutation', 'onboard', 'opportunities', 'query', 'refresh', 'reindex', 'scan', 'serve', 'trace']);
});

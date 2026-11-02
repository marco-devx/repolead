import { expect, test } from '@rstest/core';

import { sdkTokenBreakdown, sdkTokenUsage } from './agent-sdk-model';

test('SDK accounting uses per-model query totals once, including cached input and auxiliary models', () => {
  const usage = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 30, cache_read_input_tokens: 100 };
  expect(sdkTokenUsage({ usage, modelUsage: {
    main: { inputTokens: 10, outputTokens: 6, cacheCreationInputTokens: 30, cacheReadInputTokens: 200 },
    auxiliary: { inputTokens: 20, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  } })).toEqual({ inputTokens: 260, outputTokens: 8 });
  expect(sdkTokenUsage({ usage, modelUsage: {} })).toEqual({ inputTokens: 135, outputTokens: 3 });
  expect(sdkTokenBreakdown({ usage, modelUsage: { main: { inputTokens: 10, outputTokens: 6, cacheCreationInputTokens: 30, cacheReadInputTokens: 200 },
    auxiliary: { inputTokens: 20, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } } }))
    .toEqual({ uncachedInputTokens: 30, cacheWriteInputTokens: 30, cacheReadInputTokens: 200, outputTokens: 8, totalTokens: 268 });
  expect(sdkTokenBreakdown({ usage })).toEqual({ uncachedInputTokens: 5, cacheWriteInputTokens: 30, cacheReadInputTokens: 100, outputTokens: 3, totalTokens: 138 });
});

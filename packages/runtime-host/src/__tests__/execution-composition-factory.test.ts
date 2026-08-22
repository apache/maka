import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionSourceOptions,
} from '../server/execution-composition-factory.js';
import type { ExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import type { RuntimeHostCompositionContext } from '../server/host-kernel.js';

test('an execution Host starts without a managed Git runtime', async () => {
  const expected = {} as ExecutionRuntimeHostComposition;
  let observed: ExecutionRuntimeHostCompositionSourceOptions | undefined;
  const source = await createExecutionRuntimeHostCompositionSource(
    {},
    {
      createComposition: async (_context, options) => {
        observed = options;
        return expected;
      },
    },
  );

  const actual = await source.create({} as RuntimeHostCompositionContext);

  assert.equal(actual, expected);
  assert.deepEqual(observed, {});
});

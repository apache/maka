import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { isProjectPathMismatchError } from '@maka/storage';
import { createRuntimeHostProjectCatalog } from '../runtime-host-project-catalog.js';

test('Host touch conflicts retain the Project path mismatch contract', async () => {
  const catalog = createRuntimeHostProjectCatalog(() =>
    ({
      touchProject: async () => {
        throw new RuntimeHostOperationError(
          'project.catalog.mutate',
          'operation_conflict',
          'Path does not belong to project project-1',
        );
      },
    }) as never,
  );

  await assert.rejects(
    () => catalog.touch('project-1', '/workspace/other'),
    (error: unknown) => isProjectPathMismatchError(error),
  );
});

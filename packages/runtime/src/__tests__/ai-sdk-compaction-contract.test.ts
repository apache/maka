import { test } from 'node:test';

import type { AiSdkBackendInput } from '../ai-sdk-backend.js';
import type { AiSdkCompaction, AiSdkCompactionDeps } from '../ai-sdk-compaction.js';
import type { AiSdkCompactionCapabilities } from '../ai-sdk-compaction-contract.js';

type IsExact<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends <T>() => T extends Expected ? 1 : 2
    ? (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual ? 1 : 2
      ? true
      : false
    : false;

function assertType<Condition extends true>(): void {}

test('AiSdkCompaction depends on its narrow capability contract', () => {
  assertType<IsExact<AiSdkCompactionDeps['input'], AiSdkCompactionCapabilities>>();
  assertType<AiSdkBackendInput extends AiSdkCompactionCapabilities ? true : false>();
  assertType<IsExact<ConstructorParameters<typeof AiSdkCompaction>[0], AiSdkCompactionDeps>>();
});

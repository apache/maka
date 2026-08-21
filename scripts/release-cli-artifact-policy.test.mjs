import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CLI_RELEASE_ARTIFACT_LIMITS,
  validateCliReleaseArtifactMetrics,
} from './release-cli-artifact-policy.mjs';

describe('CLI release artifact policy', () => {
  test('accepts the established proof-tarball baseline', () => {
    assert.doesNotThrow(() =>
      validateCliReleaseArtifactMetrics({
        compressedBytes: 15_005_877,
        unpackedBytes: 77_684_229,
        entryCount: 7_511,
      }),
    );
  });

  test('rejects each metric above its reviewed ceiling', () => {
    for (const key of Object.keys(CLI_RELEASE_ARTIFACT_LIMITS)) {
      const metrics = {
        ...CLI_RELEASE_ARTIFACT_LIMITS,
        [key]: CLI_RELEASE_ARTIFACT_LIMITS[key] + 1,
      };
      assert.throws(() => validateCliReleaseArtifactMetrics(metrics), new RegExp(key));
    }
  });

  test('rejects malformed metrics instead of coercing them', () => {
    assert.throws(
      () =>
        validateCliReleaseArtifactMetrics({
          compressedBytes: Number.NaN,
          unpackedBytes: 1,
          entryCount: 1,
        }),
      /compressedBytes/,
    );
  });
});

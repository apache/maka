// The first installable proof tarball was 15,005,877 compressed bytes,
// 77,684,229 unpacked bytes, and 7,511 entries. These ceilings preserve
// deliberate headroom while making an accidental dependency/content spike a
// reviewed release change instead of silently shipping it.
export const CLI_RELEASE_ARTIFACT_LIMITS = Object.freeze({
  compressedBytes: 18 * 1024 * 1024,
  unpackedBytes: 90 * 1024 * 1024,
  entryCount: 9_000,
});

export function validateCliReleaseArtifactMetrics(metrics) {
  for (const key of ['compressedBytes', 'unpackedBytes', 'entryCount']) {
    const value = metrics[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CLI release artifact ${key} must be a non-negative safe integer`);
    }
    const limit = CLI_RELEASE_ARTIFACT_LIMITS[key];
    if (value > limit) {
      throw new Error(`CLI release artifact ${key} is ${value}; limit is ${limit}`);
    }
  }
}

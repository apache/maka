const UUID_V4_FRAGMENT = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';

export const ARTIFACT_PURGE_INTENT_FILE = '.artifact-purge-intent.json';
export const ARTIFACT_WRITER_LOCK_FILE = '.maka-artifact-writer.lock';

export const ARTIFACT_PURGE_INTENT_TEMP_PATTERN = new RegExp(
  `^\\.artifact-purge-intent\\.json\\.[0-9]+\\.${UUID_V4_FRAGMENT}\\.tmp$`,
);

export const ARTIFACT_PUBLICATION_STAGING_PATTERN = new RegExp(
  `^\\.artifact-publish\\.([a-f0-9]{64})\\.${UUID_V4_FRAGMENT}\\.tmp$`,
);

export function isArtifactPurgeRecoveryTempName(name: string): boolean {
  return ARTIFACT_PURGE_INTENT_TEMP_PATTERN.test(name);
}

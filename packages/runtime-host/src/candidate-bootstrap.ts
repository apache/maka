import { readFileSync } from 'node:fs';

const PACKAGED_AUTHORITY_FD = 3;
const PACKAGED_AUTHORITY_MAX_BYTES = 4_096;

export interface PackagedCandidateBootstrap {
  readonly kind: 'maka_packaged_candidate_bootstrap_v1';
  readonly parentPid: number;
  readonly resourcesRoot: string;
}

export function encodePackagedCandidateBootstrap(resourcesRoot: string, parentPid: number): string {
  return `${JSON.stringify({
    kind: 'maka_packaged_candidate_bootstrap_v1',
    parentPid,
    resourcesRoot,
  } satisfies PackagedCandidateBootstrap)}\n`;
}

export function readPackagedCandidateBootstrap(): PackagedCandidateBootstrap | undefined {
  let raw: string;
  try {
    raw = readFileSync(PACKAGED_AUTHORITY_FD, 'utf8');
  } catch (error) {
    if (isMissingBootstrapChannel(error)) return undefined;
    throw error;
  }
  if (Buffer.byteLength(raw, 'utf8') > PACKAGED_AUTHORITY_MAX_BYTES) {
    throw new Error('Packaged candidate bootstrap exceeds its byte limit');
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid packaged candidate bootstrap');
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'kind,parentPid,resourcesRoot' ||
    record.kind !== 'maka_packaged_candidate_bootstrap_v1' ||
    !Number.isSafeInteger(record.parentPid) ||
    record.parentPid !== process.ppid ||
    typeof record.resourcesRoot !== 'string' ||
    record.resourcesRoot.length === 0
  ) {
    throw new Error('Invalid packaged candidate bootstrap');
  }
  return Object.freeze({
    kind: 'maka_packaged_candidate_bootstrap_v1',
    parentPid: record.parentPid as number,
    resourcesRoot: record.resourcesRoot,
  });
}

function isMissingBootstrapChannel(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EBADF' || error.code === 'EINVAL' || error.code === 'ENXIO')
  );
}

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProductReleaseVersion } from './release-version.mjs';

const PACKAGE_NAME = 'maka-agent';
const REPOSITORY = 'apache/maka';
const WORKFLOW_PATH = '.github/workflows/asf-npm-candidate.yml';
const RECORD_SCHEMA_VERSION = 1;
const defaultRepoRoot = resolve(import.meta.dirname, '..');

export function asfNpmCandidateIdentity(version) {
  parseProductReleaseVersion(version);
  const tarball = `${PACKAGE_NAME}-${version}.tgz`;
  return {
    packageName: PACKAGE_NAME,
    version,
    tarball,
    sha256: `${tarball}.sha256`,
    sha512: `${tarball}.sha512`,
    inventory: `${tarball}.files.json`,
    record: `${tarball}.asf-candidate.json`,
  };
}

export function parseAsfSourceCandidateTag(tag, version) {
  asfNpmCandidateIdentity(version);
  const prefix = `v${version}-incubating-rc`;
  if (typeof tag !== 'string' || !tag.startsWith(prefix)) {
    throw new Error(`Source candidate tag must match ${prefix}<positive-integer>`);
  }
  const rc = tag.slice(prefix.length);
  if (!/^[1-9]\d*$/u.test(rc)) {
    throw new Error(`Source candidate tag must match ${prefix}<positive-integer>`);
  }
  return { tag, rc: Number(rc) };
}

export function createAsfNpmCandidateRecord({
  repoRoot = defaultRepoRoot,
  releaseDirectory = join(repoRoot, 'packages/cli/release'),
  version,
  sourceCandidateTag,
  sourceCommit,
  runId,
  runAttempt,
}) {
  const identity = asfNpmCandidateIdentity(version);
  validateRepositoryVersion(repoRoot, version);
  const source = validateSourceIdentity({
    sourceCandidateTag,
    sourceCommit,
    version,
  });
  const workflow = validateWorkflowIdentity({ runId, runAttempt });
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    artifactType: 'npm-convenience-candidate',
    packageName: PACKAGE_NAME,
    version,
    tarball: identity.tarball,
    digests: {
      sha256: candidate.sha256,
      sha512: candidate.sha512,
    },
    sourceRelease: source,
    workflow,
  };
  const recordPath = join(releaseDirectory, identity.record);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  });
  return { record, recordPath };
}

export function verifyAsfNpmCandidateRecord({ recordPath }) {
  const record = readJson(recordPath, 'ASF npm candidate record');
  exactKeys(
    record,
    [
      'schemaVersion',
      'artifactType',
      'packageName',
      'version',
      'tarball',
      'digests',
      'sourceRelease',
      'workflow',
    ],
    'ASF npm candidate record',
  );
  if (
    record.schemaVersion !== RECORD_SCHEMA_VERSION ||
    record.artifactType !== 'npm-convenience-candidate' ||
    record.packageName !== PACKAGE_NAME
  ) {
    throw new Error('Unsupported ASF npm candidate record');
  }
  const identity = asfNpmCandidateIdentity(record.version);
  if (record.tarball !== identity.tarball) {
    throw new Error('ASF npm candidate record tarball is inconsistent');
  }
  exactKeys(record.digests, ['sha256', 'sha512'], 'ASF npm candidate digests');
  const source = validateSourceIdentity({
    sourceCandidateTag: record.sourceRelease?.candidateTag,
    sourceCommit: record.sourceRelease?.commit,
    version: record.version,
  });
  exactKeys(record.sourceRelease, ['candidateTag', 'commit', 'rc'], 'ASF source release identity');
  if (record.sourceRelease.rc !== source.rc) {
    throw new Error('ASF npm candidate record RC number is inconsistent');
  }
  exactKeys(record.workflow, ['repository', 'path', 'runId', 'runAttempt'], 'workflow identity');
  validateWorkflowIdentity(record.workflow ?? {});
  const candidate = validateCandidateFiles(dirname(resolve(recordPath)), identity);
  if (record.digests.sha256 !== candidate.sha256 || record.digests.sha512 !== candidate.sha512) {
    throw new Error('ASF npm candidate record digest does not match the tarball');
  }
  return { record, tarballPath: candidate.tarballPath };
}

function validateRepositoryVersion(repoRoot, version) {
  const root = readJson(join(repoRoot, 'package.json'), 'root package manifest');
  const cli = readJson(join(repoRoot, 'packages/cli/package.json'), 'CLI package manifest');
  if (root.version !== version || cli.version !== version) {
    throw new Error(
      `Release version ${version} does not match root ${root.version} and CLI ${cli.version}`,
    );
  }
}

function validateSourceIdentity({ sourceCandidateTag, sourceCommit, version }) {
  const { tag, rc } = parseAsfSourceCandidateTag(sourceCandidateTag, version);
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('ASF source candidate commit must be a full lowercase Git SHA');
  }
  return { candidateTag: tag, rc, commit: sourceCommit };
}

function validateWorkflowIdentity({
  repository = REPOSITORY,
  path = WORKFLOW_PATH,
  runId,
  runAttempt,
}) {
  if (repository !== REPOSITORY) throw new Error(`Workflow repository must be ${REPOSITORY}`);
  if (path !== WORKFLOW_PATH) throw new Error(`Workflow path must be ${WORKFLOW_PATH}`);
  if (!isPositiveIntegerString(runId)) throw new Error('Workflow run ID is invalid');
  if (!isPositiveIntegerString(runAttempt)) throw new Error('Workflow run attempt is invalid');
  return {
    repository,
    path,
    runId: String(runId),
    runAttempt: String(runAttempt),
  };
}

function validateCandidateFiles(releaseDirectory, identity) {
  const tarballPath = join(releaseDirectory, identity.tarball);
  const bytes = readFileSync(tarballPath);
  const sha256 = digest(bytes, 'sha256');
  const sha512 = digest(bytes, 'sha512');
  validateChecksumFile(join(releaseDirectory, identity.sha256), identity.tarball, sha256, 64);
  validateChecksumFile(join(releaseDirectory, identity.sha512), identity.tarball, sha512, 128);
  const inventory = readJson(join(releaseDirectory, identity.inventory), 'npm candidate inventory');
  if (
    !Array.isArray(inventory) ||
    inventory.length === 0 ||
    inventory.some((entry) => !entry || typeof entry.path !== 'string' || entry.path.length === 0)
  ) {
    throw new Error('npm candidate inventory is invalid');
  }
  return { tarballPath, sha256, sha512 };
}

function validateChecksumFile(path, tarball, expectedDigest, digestLength) {
  const contents = readFileSync(path, 'utf8');
  const match = new RegExp(`^([0-9a-f]{${digestLength}})  ([^\\r\\n]+)\\r?\\n?$`, 'u').exec(
    contents,
  );
  if (!match || match[2] !== tarball) {
    throw new Error(`${basename(path)} is malformed`);
  }
  if (match[1] !== expectedDigest) {
    throw new Error(`${basename(path)} does not match the npm candidate`);
  }
}

function exactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function isPositiveIntegerString(value) {
  return /^[1-9]\d*$/u.test(String(value ?? ''));
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex');
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'record') {
    const [releaseDirectory, version, sourceCandidateTag, sourceCommit, runId, runAttempt] =
      arguments_;
    if (
      arguments_.length !== 6 ||
      !releaseDirectory ||
      !version ||
      !sourceCandidateTag ||
      !sourceCommit ||
      !runId ||
      !runAttempt
    ) {
      throw new Error(
        'Usage: asf-npm-candidate.mjs record <release-directory> <version> <source-candidate-tag> <source-commit> <run-id> <run-attempt>',
      );
    }
    const result = createAsfNpmCandidateRecord({
      releaseDirectory: resolve(releaseDirectory),
      version,
      sourceCandidateTag,
      sourceCommit,
      runId,
      runAttempt,
    });
    console.log(`Created ${result.recordPath}`);
    return;
  }
  if (command === 'verify') {
    const [recordPath] = arguments_;
    if (arguments_.length !== 1 || !recordPath) {
      throw new Error('Usage: asf-npm-candidate.mjs verify <record>');
    }
    const result = verifyAsfNpmCandidateRecord({
      recordPath: resolve(recordPath),
    });
    console.log(`Verified ${result.tarballPath}`);
    return;
  }
  throw new Error('Usage: asf-npm-candidate.mjs <record|verify> [options]');
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

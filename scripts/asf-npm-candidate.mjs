import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAsfSourceReferenceTag } from './product-release-identity.mjs';
import { parseProductReleaseVersion } from './release-version.mjs';

export { parseAsfSourceReferenceTag };

const PACKAGE_NAME = 'maka-agent';
const ASF_REPOSITORY = 'apache/maka';
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

export function createAsfNpmCandidateRecord({
  repoRoot = defaultRepoRoot,
  releaseDirectory = join(repoRoot, 'packages/cli/release'),
  version,
  sourceReferenceTag,
  sourceCommit,
  repository,
  runId,
  runAttempt,
}) {
  const identity = asfNpmCandidateIdentity(version);
  validateRepositoryVersion(repoRoot, version);
  const sourceReference = validateSourceReference({
    sourceReferenceTag,
    sourceCommit,
    version,
  });
  const workflow = validateWorkflowIdentity({
    repository,
    path: WORKFLOW_PATH,
    runId,
    runAttempt,
  });
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  writeFileSync(
    join(releaseDirectory, identity.sha512),
    `${candidate.sha512}  ${identity.tarball}\n`,
    { flag: 'wx', mode: 0o644 },
  );
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
    sourceReference,
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
      'sourceReference',
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
  exactKeys(record.sourceReference, ['candidateTag', 'commit'], 'ASF source reference');
  validateSourceReference({
    sourceReferenceTag: record.sourceReference.candidateTag,
    sourceCommit: record.sourceReference.commit,
    version: record.version,
  });
  exactKeys(record.workflow, ['repository', 'path', 'runId', 'runAttempt'], 'workflow identity');
  validateWorkflowIdentity(record.workflow);
  const releaseDirectory = dirname(resolve(recordPath));
  const candidate = validateCandidateFiles(releaseDirectory, identity);
  validateChecksumFile(
    join(releaseDirectory, identity.sha512),
    identity.tarball,
    candidate.sha512,
    128,
  );
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

function validateSourceReference({ sourceReferenceTag, sourceCommit, version }) {
  const parsedTag = parseAsfSourceReferenceTag(sourceReferenceTag);
  if (parsedTag.version !== version) {
    throw new Error(`Source candidate tag version ${parsedTag.version} does not match ${version}`);
  }
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('ASF source candidate commit must be a full lowercase Git SHA');
  }
  return { candidateTag: parsedTag.tag, commit: sourceCommit };
}

function validateWorkflowIdentity({ repository, path, runId, runAttempt }) {
  if (repository !== ASF_REPOSITORY) {
    throw new Error(`Workflow repository must be ${ASF_REPOSITORY}`);
  }
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
  if (command === 'source-version') {
    const [sourceReferenceTag] = arguments_;
    if (arguments_.length !== 1 || !sourceReferenceTag) {
      throw new Error('Usage: asf-npm-candidate.mjs source-version <source-reference-tag>');
    }
    console.log(parseAsfSourceReferenceTag(sourceReferenceTag).version);
    return;
  }
  if (command === 'record') {
    const [
      releaseDirectory,
      version,
      sourceReferenceTag,
      sourceCommit,
      repository,
      runId,
      runAttempt,
    ] = arguments_;
    if (
      arguments_.length !== 7 ||
      !releaseDirectory ||
      !version ||
      !sourceReferenceTag ||
      !sourceCommit ||
      !repository ||
      !runId ||
      !runAttempt
    ) {
      throw new Error(
        'Usage: asf-npm-candidate.mjs record <release-directory> <version> <source-reference-tag> <source-commit> <repository> <run-id> <run-attempt>',
      );
    }
    const result = createAsfNpmCandidateRecord({
      releaseDirectory: resolve(releaseDirectory),
      version,
      sourceReferenceTag,
      sourceCommit,
      repository,
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
  throw new Error('Usage: asf-npm-candidate.mjs <source-version|record|verify> [options]');
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

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIME_HOST_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
const WINDOWS_SECURITY_TEXT_MAX_CHARS = 4 * 1024;
const DIAGNOSTIC_TEXT_MAX_CHARS = 2 * 1024;
const WINDOWS_DIAGNOSTIC_PATH_ENV = 'MAKA_RUNTIME_HOST_DIAGNOSTIC_PATH';
const WINDOWS_PATH_SECURITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:${WINDOWS_DIAGNOSTIC_PATH_ENV}
[Console]::Out.Write((@{
  owner = $acl.Owner
  sddl = $acl.Sddl
} | ConvertTo-Json -Compress))
`;

const STORAGE_AUTHORITY_MODULE = 'node_modules/@maka/storage/dist/root-authority.js';
const REGISTRATION_MODULE = 'node_modules/@maka/runtime-host/dist/control/registration.js';
const STARTUP_DIAGNOSTIC_MODULE =
  'node_modules/@maka/runtime-host/dist/control/startup-diagnostic.js';

export async function collectRuntimeHostFailureDiagnostic(packageRoot, rootPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const loadInstalled = options.loadInstalled ?? importInstalled;
  const readPathSecurity =
    options.readPathSecurity ??
    (platform === 'win32'
      ? (path) => readWindowsPathSecurity(path, environment)
      : async () => undefined);
  const diagnostic = {
    schemaVersion: 1,
    platform,
    architecture: options.architecture ?? process.arch,
    runner: compactObject({
      imageOS: boundedOptionalString(environment.ImageOS),
      imageVersion: boundedOptionalString(environment.ImageVersion),
      name: boundedOptionalString(environment.RUNNER_NAME),
      environment: boundedOptionalString(environment.RUNNER_ENVIRONMENT),
    }),
    paths: [],
  };

  await addPathEvidence(diagnostic.paths, 'root', rootPath, readPathSecurity, true);

  let authority;
  try {
    authority = await loadInstalled(packageRoot, STORAGE_AUTHORITY_MODULE);
  } catch (error) {
    diagnostic.storageAuthority = { state: 'unavailable', error: summarizeDiagnosticError(error) };
    return diagnostic;
  }

  await addPathEvidence(
    diagnostic.paths,
    'root_marker',
    join(rootPath, authority.STORAGE_ROOT_MARKER_FILE),
    readPathSecurity,
    false,
  );

  let capability;
  try {
    capability = await authority.discoverMarkedStorageRoot({ path: rootPath });
    diagnostic.storageAuthority = { state: 'valid', rootId: capability.rootId };
  } catch (error) {
    diagnostic.storageAuthority = { state: 'invalid', error: summarizeDiagnosticError(error) };
  }

  let controlRoot;
  try {
    controlRoot = authority.resolveRootControlNamespace();
    await addPathEvidence(diagnostic.paths, 'control_root', controlRoot, readPathSecurity, true);
  } catch (error) {
    diagnostic.controlNamespace = {
      state: 'unavailable',
      error: summarizeDiagnosticError(error),
    };
  }
  if (!capability || !controlRoot) return diagnostic;

  const controlDirectory = join(controlRoot, capability.rootId);
  await addPathEvidence(
    diagnostic.paths,
    'control_directory',
    controlDirectory,
    readPathSecurity,
    true,
  );

  try {
    const registrationAuthority = await loadInstalled(packageRoot, REGISTRATION_MODULE);
    const registrationPath = join(
      controlDirectory,
      registrationAuthority.RUNTIME_HOST_REGISTRATION_FILE,
    );
    await addPathEvidence(
      diagnostic.paths,
      'registration',
      registrationPath,
      readPathSecurity,
      false,
    );
    const registration = await registrationAuthority.readHostRegistration(controlDirectory);
    diagnostic.registration = registration
      ? summarizeRegistration(registration, capability.rootId)
      : { state: 'absent' };
  } catch (error) {
    diagnostic.registration = { state: 'unavailable', error: summarizeDiagnosticError(error) };
  }

  try {
    const startupAuthority = await loadInstalled(packageRoot, STARTUP_DIAGNOSTIC_MODULE);
    const startupPath = join(
      controlDirectory,
      startupAuthority.RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE,
    );
    await addPathEvidence(
      diagnostic.paths,
      'startup_diagnostic',
      startupPath,
      readPathSecurity,
      false,
    );
    const startup = await startupAuthority.readCandidateStartupDiagnostic(capability.rootId);
    diagnostic.startup = startup ? { state: 'present', diagnostic: startup } : { state: 'absent' };
  } catch (error) {
    diagnostic.startup = { state: 'unavailable', error: summarizeDiagnosticError(error) };
  }

  return diagnostic;
}

export function renderRuntimeHostFailureDiagnostic(diagnostic) {
  return truncateUtf8Text(
    JSON.stringify(diagnostic),
    RUNTIME_HOST_DIAGNOSTIC_MAX_BYTES,
    '<diagnostic truncated>',
  );
}

async function addPathEvidence(paths, role, path, readPathSecurity, includeSecurity) {
  const evidence = inspectDiagnosticPath(role, path);
  if (includeSecurity && evidence.state === 'present') {
    try {
      evidence.security = await readPathSecurity(path);
    } catch (error) {
      evidence.security = { state: 'unavailable', error: summarizeDiagnosticError(error) };
    }
  }
  paths.push(evidence);
}

function inspectDiagnosticPath(role, path) {
  try {
    const pathStat = statSync(path);
    return {
      role,
      path,
      state: 'present',
      kind: pathStat.isDirectory() ? 'directory' : pathStat.isFile() ? 'file' : 'other',
      size: pathStat.size,
      mode: pathStat.mode,
    };
  } catch (error) {
    return { role, path, state: 'unavailable', error: summarizeDiagnosticError(error) };
  }
}

function readWindowsPathSecurity(path, environment) {
  const systemRoot = environment.SystemRoot;
  if (!systemRoot) throw new Error('SystemRoot is unavailable');
  const output = execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_SECURITY_SCRIPT],
    {
      encoding: 'utf8',
      env: { ...environment, [WINDOWS_DIAGNOSTIC_PATH_ENV]: path },
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(output);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.owner !== 'string' ||
    typeof parsed.sddl !== 'string'
  ) {
    throw new Error('Windows path security probe returned an invalid response');
  }
  return {
    state: 'present',
    owner: parsed.owner.slice(0, WINDOWS_SECURITY_TEXT_MAX_CHARS),
    sddl: parsed.sddl.slice(0, WINDOWS_SECURITY_TEXT_MAX_CHARS),
  };
}

function summarizeRegistration(registration, expectedRootId) {
  return compactObject({
    state: 'present',
    schemaVersion: registration.schemaVersion,
    rootIdMatches: registration.rootId === expectedRootId,
    hostEpoch: registration.hostEpoch,
    lifecycleState: registration.state,
    lifecycleMode: registration.lifecycleMode,
    pid: registration.pid,
    endpointKind:
      typeof registration.endpoint === 'string' && registration.endpoint.startsWith('\\\\.\\pipe\\')
        ? 'windows_named_pipe'
        : 'other',
  });
}

function summarizeDiagnosticError(error, depth = 0) {
  if (!(error instanceof Error)) return { message: boundedDiagnosticString(String(error)) };
  return compactObject({
    name: boundedDiagnosticString(error.name),
    code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined,
    message: boundedDiagnosticString(error.message),
    cause:
      depth < 3 && error.cause !== undefined
        ? summarizeDiagnosticError(error.cause, depth + 1)
        : undefined,
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function boundedOptionalString(value) {
  return typeof value === 'string' ? boundedDiagnosticString(value) : undefined;
}

function boundedDiagnosticString(value) {
  return value.slice(0, DIAGNOSTIC_TEXT_MAX_CHARS);
}

function truncateUtf8Text(value, maximumBytes, marker) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return value;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const prefix = encoded
    .subarray(0, Math.max(0, maximumBytes - markerBytes))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return `${prefix}${marker}`;
}

function importInstalled(packageRoot, relativePath) {
  return import(pathToFileURL(join(packageRoot, relativePath)).href);
}

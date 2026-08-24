/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIME_HOST_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
const WINDOWS_SECURITY_TEXT_MAX_CHARS = 4 * 1024;
const DIAGNOSTIC_TEXT_MAX_CHARS = 2 * 1024;
const WINDOWS_PATH_SECURITY_TIMEOUT_MS = 30_000;
const WINDOWS_DIAGNOSTIC_PATHS_ENV = 'MAKA_RUNTIME_HOST_DIAGNOSTIC_PATHS';
const WINDOWS_PATH_SECURITY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json -InputObject $env:${WINDOWS_DIAGNOSTIC_PATHS_ENV}
$results = @()
foreach ($path in @($paths)) {
  try {
    $acl = Get-Acl -LiteralPath $path
    $results += [ordered]@{
      state = 'present'
      owner = $acl.Owner
      sddl = $acl.Sddl
    }
  } catch {
    $exception = $_.Exception
    $nativeErrorCode = $null
    if ($null -ne $exception.PSObject.Properties['NativeErrorCode']) {
      $nativeErrorCode = $exception.NativeErrorCode
    }
    $results += [ordered]@{
      state = 'unavailable'
      error = [ordered]@{
        name = $exception.GetType().FullName
        hresult = $exception.HResult
        nativeErrorCode = $nativeErrorCode
        message = $exception.Message
      }
    }
  }
}
$response = [ordered]@{ results = @($results) }
[Console]::Out.Write((ConvertTo-Json -InputObject $response -Compress -Depth 5))
`;

const STORAGE_AUTHORITY_MODULE = 'node_modules/@maka/storage/dist/root-authority.js';
const REGISTRATION_MODULE = 'node_modules/@maka/runtime-host/dist/control/registration.js';
const STARTUP_DIAGNOSTIC_MODULE =
  'node_modules/@maka/runtime-host/dist/control/startup-diagnostic.js';

export async function collectRuntimeHostFailureDiagnostic(packageRoot, rootPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const loadInstalled = options.loadInstalled ?? importInstalled;
  const readPathSecurityBatch =
    options.readPathSecurityBatch ??
    (platform === 'win32'
      ? (paths) => readWindowsPathSecurityBatch(paths, environment)
      : undefined);
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

  addPathEvidence(diagnostic.paths, 'root', rootPath);

  const finish = async () => {
    if (readPathSecurityBatch) {
      await addPathSecurityEvidence(diagnostic.paths, readPathSecurityBatch);
    }
    return diagnostic;
  };

  let authority;
  try {
    authority = await loadInstalled(packageRoot, STORAGE_AUTHORITY_MODULE);
  } catch (error) {
    diagnostic.storageAuthority = { state: 'unavailable', error: summarizeDiagnosticError(error) };
    return finish();
  }

  addPathEvidence(
    diagnostic.paths,
    'root_marker',
    join(rootPath, authority.STORAGE_ROOT_MARKER_FILE),
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
    addPathEvidence(diagnostic.paths, 'control_root', controlRoot);
  } catch (error) {
    diagnostic.controlNamespace = {
      state: 'unavailable',
      error: summarizeDiagnosticError(error),
    };
  }
  if (!capability || !controlRoot) return finish();

  const controlDirectory = join(controlRoot, capability.rootId);
  addPathEvidence(diagnostic.paths, 'control_directory', controlDirectory);

  try {
    const registrationAuthority = await loadInstalled(packageRoot, REGISTRATION_MODULE);
    const registrationPath = join(
      controlDirectory,
      registrationAuthority.RUNTIME_HOST_REGISTRATION_FILE,
    );
    addPathEvidence(diagnostic.paths, 'registration', registrationPath);
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
    addPathEvidence(diagnostic.paths, 'startup_diagnostic', startupPath);
    const startup = await startupAuthority.readCandidateStartupDiagnostic(capability.rootId);
    diagnostic.startup = startup ? { state: 'present', diagnostic: startup } : { state: 'absent' };
  } catch (error) {
    diagnostic.startup = { state: 'unavailable', error: summarizeDiagnosticError(error) };
  }

  return finish();
}

export function renderRuntimeHostFailureDiagnostic(diagnostic) {
  return truncateUtf8Text(
    JSON.stringify(diagnostic),
    RUNTIME_HOST_DIAGNOSTIC_MAX_BYTES,
    '<diagnostic truncated>',
  );
}

export async function retireCollectedRuntimeHostStartupDiagnostic(
  packageRoot,
  diagnostic,
  options = {},
) {
  const startupAttemptId = diagnostic.startup?.diagnostic?.startupAttemptId;
  const rootId = diagnostic.storageAuthority?.rootId;
  if (typeof rootId !== 'string' || typeof startupAttemptId !== 'string') return false;
  const loadInstalled = options.loadInstalled ?? importInstalled;
  const startupAuthority = await loadInstalled(packageRoot, STARTUP_DIAGNOSTIC_MODULE);
  return startupAuthority.clearSelectedCandidateStartupDiagnostic(rootId, startupAttemptId);
}

function addPathEvidence(paths, role, path) {
  paths.push(inspectDiagnosticPath(role, path));
}

async function addPathSecurityEvidence(paths, readPathSecurityBatch) {
  const evidence = paths.filter(
    (entry) =>
      entry.state === 'present' &&
      (entry.role === 'root' ||
        entry.role === 'control_root' ||
        entry.role === 'control_directory'),
  );
  if (evidence.length === 0) return;
  try {
    const results = await readPathSecurityBatch(evidence.map(({ path }) => path));
    if (!Array.isArray(results) || results.length !== evidence.length) {
      throw new Error('Windows path security probe returned an invalid result count');
    }
    for (let index = 0; index < evidence.length; index += 1) {
      evidence[index].security = results[index];
    }
  } catch (error) {
    const unavailable = { state: 'unavailable', error: summarizeDiagnosticError(error) };
    for (const entry of evidence) entry.security = unavailable;
  }
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

function readWindowsPathSecurityBatch(paths, environment) {
  const systemRoot = environment.SystemRoot;
  if (!systemRoot) throw new Error('SystemRoot is unavailable');
  const output = execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PATH_SECURITY_SCRIPT],
    {
      encoding: 'utf8',
      env: { ...environment, [WINDOWS_DIAGNOSTIC_PATHS_ENV]: JSON.stringify(paths) },
      timeout: WINDOWS_PATH_SECURITY_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const parsed = JSON.parse(output);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray(parsed.results) ||
    parsed.results.length !== paths.length
  ) {
    throw new Error('Windows path security probe returned an invalid response');
  }
  return parsed.results.map(decodeWindowsPathSecurity);
}

function decodeWindowsPathSecurity(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    value.state === 'present' &&
    typeof value.owner === 'string' &&
    typeof value.sddl === 'string'
  ) {
    return {
      state: 'present',
      owner: value.owner.slice(0, WINDOWS_SECURITY_TEXT_MAX_CHARS),
      sddl: value.sddl.slice(0, WINDOWS_SECURITY_TEXT_MAX_CHARS),
    };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    value.state === 'unavailable' &&
    typeof value.error === 'object' &&
    value.error !== null &&
    typeof value.error.message === 'string'
  ) {
    return {
      state: 'unavailable',
      error: compactObject({
        name:
          typeof value.error.name === 'string'
            ? boundedDiagnosticString(value.error.name)
            : undefined,
        hresult: Number.isSafeInteger(value.error.hresult) ? value.error.hresult : undefined,
        nativeErrorCode: Number.isSafeInteger(value.error.nativeErrorCode)
          ? value.error.nativeErrorCode
          : undefined,
        message: boundedDiagnosticString(value.error.message),
      }),
    };
  }
  throw new Error('Windows path security probe returned an invalid path result');
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

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import type { SandboxBackend, SandboxTransformRequest, SandboxTransformResult } from './types.js';
import { compileWindowsSandboxPolicy } from './windows-profile.js';

export interface WindowsBrokerManifest {
  readonly version: 1;
  readonly requestId: string;
  readonly clientPid: 0;
  readonly clientNonce: string;
  readonly profileDigest: string;
  readonly launch: {
    readonly version: 1;
    readonly requestId: string;
    readonly executable: string;
    readonly arguments: readonly string[];
    readonly cwd: string;
    readonly readRoots: readonly string[];
    readonly writeRoots: readonly string[];
    readonly network: 'restricted' | 'enabled';
    readonly environment: Readonly<Record<string, string>>;
  };
}

export interface WindowsSandboxBackendOptions {
  readonly clientPath: string;
  readonly writeManifest: (manifest: WindowsBrokerManifest) => string;
  readonly nonce?: () => string;
  readonly requestId?: () => string;
  readonly isAvailable?: () => boolean;
}

export function createWindowsBrokerManifestWriter(
  temporaryRoot: string = tmpdir(),
): (manifest: WindowsBrokerManifest) => string {
  const directory = mkdtempSync(join(temporaryRoot, 'maka-windows-sandbox-'));
  return (manifest) => {
    const path = join(directory, `${manifest.requestId}-${randomBytes(8).toString('hex')}.json`);
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(manifest), 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    return path;
  };
}

export class WindowsBrokerSandboxBackend implements SandboxBackend {
  readonly type = 'windows' as const;

  constructor(private readonly options: WindowsSandboxBackendOptions) {}

  isAvailable(platform: string = process.platform): boolean {
    return platform === 'win32' && (this.options.isAvailable?.() ?? true);
  }

  canEnforceProfile(profile: SandboxTransformRequest['command']['profile']): boolean {
    return profile.type === 'managed' && profile.fileSystem.kind === 'restricted';
  }

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    const preference = request.preference ?? 'auto';
    const platform = request.platform ?? process.platform;
    if (platform !== 'win32') {
      return failure(
        'unsupported_platform',
        'Windows broker backend requires win32.',
        platform,
        preference,
      );
    }
    if (!this.isAvailable(platform)) {
      return failure(
        'backend_not_available',
        'Windows sandbox broker client is not available.',
        platform,
        preference,
      );
    }
    const configurationError = validateConfiguration(this.options);
    if (configurationError) {
      return failure('invalid_request', configurationError, platform, preference);
    }

    let policy;
    try {
      policy = compileWindowsSandboxPolicy(request.command);
    } catch (error) {
      return failure(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
        platform,
        preference,
      );
    }

    const requestId = this.options.requestId?.() ?? randomBytes(16).toString('hex');
    const clientNonce = this.options.nonce?.() ?? randomBytes(16).toString('hex');
    if (requestId.length === 0 || !/^[A-Za-z0-9._:-]+$/u.test(requestId)) {
      return failure('invalid_request', 'Invalid Windows broker request id.', platform, preference);
    }
    if (!/^[a-f0-9]{32}$/iu.test(clientNonce)) {
      return failure(
        'invalid_request',
        'Invalid Windows broker client nonce.',
        platform,
        preference,
      );
    }
    let manifestPath: string;
    try {
      const launch: WindowsBrokerManifest['launch'] = {
        version: 1,
        requestId: `${requestId}-launch`,
        executable: request.command.program,
        arguments: request.command.args,
        cwd: request.command.cwd,
        readRoots: policy.readRoots,
        writeRoots: policy.writeRoots,
        network: policy.network,
        environment: sortEnvironment(policy.environment),
      };
      manifestPath = this.options.writeManifest({
        version: 1,
        requestId,
        clientPid: 0,
        clientNonce,
        profileDigest: digestLaunch(launch),
        launch,
      });
      if (!isCanonicalWindowsPath(manifestPath)) {
        throw new Error('manifest path must be canonical and absolute');
      }
    } catch (error) {
      return failure(
        'backend_not_available',
        `Unable to materialize Windows broker request: ${error instanceof Error ? error.message : String(error)}`,
        platform,
        preference,
      );
    }

    return {
      ok: true,
      exec: {
        argv: [this.options.clientPath, '--broker-local', manifestPath],
        cwd: request.command.cwd,
        env: request.command.env,
        sandboxType: 'windows',
        effectiveProfile: request.command.profile,
      },
      sandboxType: 'windows',
      requiresSandbox: true,
      preference,
    };
  }
}

function validateConfiguration(options: WindowsSandboxBackendOptions): string | undefined {
  if (!isCanonicalWindowsPath(options.clientPath)) {
    return 'Windows broker client path must be canonical and absolute.';
  }
  return undefined;
}

function digestLaunch(launch: WindowsBrokerManifest['launch']): string {
  return createHash('sha256').update(JSON.stringify(launch), 'utf8').digest('hex');
}

function sortEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function isCanonicalWindowsPath(path: string): boolean {
  return (
    win32.isAbsolute(path) &&
    !path.includes('/') &&
    win32.resolve(path).toLowerCase() === path.toLowerCase()
  );
}

function failure(
  reason: 'unsupported_platform' | 'backend_not_available' | 'invalid_request',
  message: string,
  platform: string,
  preference: 'auto' | 'require' | 'forbid',
): SandboxTransformResult {
  return {
    ok: false,
    reason,
    sandboxType: 'windows',
    requiresSandbox: true,
    platform,
    preference,
    message,
  };
}

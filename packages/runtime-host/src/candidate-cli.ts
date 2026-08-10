import type { InteractiveRuntimeHostCandidateOptions } from './server/candidate.js';
import { isAbsolute } from 'node:path';

export function parseInteractiveRuntimeHostCandidateArguments(
  args: readonly string[],
): InteractiveRuntimeHostCandidateOptions {
  const allowedKeys = new Set([
    'root',
    'expected-root-id',
    'idle-grace-ms',
    'handshake-timeout-ms',
    'legacy-configuration-root',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Invalid Runtime Host candidate arguments');
    }
    const name = key.slice(2);
    if (!allowedKeys.has(name) || values.has(name)) {
      throw new Error(`Invalid Runtime Host candidate argument: ${key}`);
    }
    values.set(name, value);
  }
  const rootPath = values.get('root');
  if (!rootPath) throw new Error('Runtime Host candidate requires --root');
  const expectedRootId = values.get('expected-root-id');
  if (!expectedRootId || !/^[a-f0-9]{64}$/.test(expectedRootId)) {
    throw new Error('Runtime Host candidate requires a valid --expected-root-id');
  }
  return {
    rootPath,
    expectedRootId,
    ...(values.has('legacy-configuration-root')
      ? {
          legacyConfigurationRoot: readOptionalAbsolutePath(values, 'legacy-configuration-root'),
        }
      : {}),
    idleGraceMs: readOptionalInteger(values, 'idle-grace-ms'),
    handshakeTimeoutMs: readOptionalInteger(values, 'handshake-timeout-ms'),
  };
}

function readOptionalAbsolutePath(values: Map<string, string>, key: string): string | undefined {
  const value = values.get(key);
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error(`Invalid --${key}`);
  return value;
}

function readOptionalInteger(values: Map<string, string>, key: string): number | undefined {
  const raw = values.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid --${key}`);
  return value;
}

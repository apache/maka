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

import { realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLED_HARNESS_RELAY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../harbor',
);

interface HarnessPreparationEnvironmentOptions {
  readonly subjectCredentialNames: readonly string[];
  readonly declared: readonly string[];
  readonly egress?: {
    readonly allowedHost: string;
    readonly networkPolicyPath: string;
  };
}

export function createHarnessPreparationEnvironment(
  options: HarnessPreparationEnvironmentOptions,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'XDG_CACHE_HOME',
    ...options.declared,
  ]);
  const credentials = new Set(options.subjectCredentialNames);
  const inherited = Object.fromEntries(
    [...allowed].flatMap((name) => {
      const value = process.env[name];
      return value === undefined || credentials.has(name) ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    PYTHONPATH: [BUNDLED_HARNESS_RELAY_ROOT, inherited.PYTHONPATH].filter(Boolean).join(delimiter),
    ...(options.egress
      ? {
          MAKA_EVAL_EGRESS_REQUIRED: '1',
          MAKA_EVAL_EGRESS_ALLOWED_HOST: options.egress.allowedHost,
          MAKA_EVAL_NETWORK_POLICY_PATH: options.egress.networkPolicyPath,
        }
      : {}),
  };
}

export function resolvePathWithinRoot(root: string, path: string, label: string): string {
  const resolved = resolve(root, path);
  assertPathWithinRoot(root, resolved, label);
  return resolved;
}

export async function resolveRealPathWithinRoot(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const resolved = resolvePathWithinRoot(root, path, label);
  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(resolved)]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} cannot be resolved: ${reason}`, { cause: error });
  }
  assertPathWithinRoot(canonicalRoot, canonicalPath, label);
  return canonicalPath;
}

function assertPathWithinRoot(root: string, path: string, label: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes its source root`);
  }
}

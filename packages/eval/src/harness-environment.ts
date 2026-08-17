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
  const fromRoot = relative(root, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes its source root`);
  }
  return resolved;
}

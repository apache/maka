import { delimiter } from 'node:path';

export function createHarnessPreparationEnvironment(
  relayPath: string,
  subjectCredentialNames: readonly string[],
  declared: readonly string[],
  egressAllowedHost?: string,
  networkPolicyPath?: string,
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
    ...declared,
  ]);
  const credentials = new Set(subjectCredentialNames);
  const inherited = Object.fromEntries(
    [...allowed].flatMap((name) => {
      const value = process.env[name];
      return value === undefined || credentials.has(name) ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    PYTHONPATH: [relayPath, inherited.PYTHONPATH].filter(Boolean).join(delimiter),
    ...(egressAllowedHost
      ? {
          MAKA_EVAL_EGRESS_REQUIRED: '1',
          MAKA_EVAL_EGRESS_ALLOWED_HOST: egressAllowedHost,
        }
      : {}),
    ...(networkPolicyPath ? { MAKA_EVAL_NETWORK_POLICY_PATH: networkPolicyPath } : {}),
  };
}

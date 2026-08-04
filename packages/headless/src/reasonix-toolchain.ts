import { createHash } from 'node:crypto';
import {
  prepareNodeCliToolchain,
  validatePreparedNodeCliToolchain,
  type PinnedNodeCliToolchainDefinition,
} from './node-cli-toolchain.js';

export const REASONIX_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-reasonix-toolchain';

export const REASONIX_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  // Reasonix ships a static Go binary and never runs on Node. The pinned Node is
  // the offline manifest verifier the container's install() step executes, the
  // same role it plays for the prebuilt OpenCode binary.
  node: {
    version: '22.23.1',
    archiveUrl: 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz',
    archiveSha256: '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
    binarySha256: '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  },
  reasonix: {
    version: '1.19.4',
    archiveUrl: 'https://registry.npmjs.org/@reasonix/cli-linux-x64/-/cli-linux-x64-1.19.4.tgz',
    archiveIntegrity:
      'sha512-H2iktxh6obnB4iV055PFEf6oBGNN7E4zMBrT9mxA4U1udeGNVb5YOuh//wA2Oo1M8kOfxQszRVWS1ebld3dUBw==',
    binarySha256: 'f2840b5e8401d45f809dceaaea9b4540c2a946c79dcd640d2db7a79021c8a474',
  },
} as const;

export const REASONIX_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(REASONIX_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedReasonixToolchain {
  path: string;
  fingerprint: typeof REASONIX_TOOLCHAIN_FINGERPRINT;
}

const DEFINITION: PinnedNodeCliToolchainDefinition<typeof REASONIX_TOOLCHAIN_SPEC> = {
  label: 'Reasonix',
  fingerprint: REASONIX_TOOLCHAIN_FINGERPRINT,
  spec: REASONIX_TOOLCHAIN_SPEC,
  node: REASONIX_TOOLCHAIN_SPEC.node,
  packageArchive: {
    url: REASONIX_TOOLCHAIN_SPEC.reasonix.archiveUrl,
    integrity: REASONIX_TOOLCHAIN_SPEC.reasonix.archiveIntegrity,
  },
  packageFiles: [
    {
      archivePath: 'package/bin/reasonix',
      installedPath: 'bin/reasonix',
      sha256: REASONIX_TOOLCHAIN_SPEC.reasonix.binarySha256,
      executable: true,
    },
  ],
};

export async function validatePreparedReasonixToolchain(
  path: string,
): Promise<PreparedReasonixToolchain> {
  await validatePreparedNodeCliToolchain(path, DEFINITION);
  return { path, fingerprint: REASONIX_TOOLCHAIN_FINGERPRINT };
}

export async function prepareReasonixToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedReasonixToolchain> {
  await prepareNodeCliToolchain(path, DEFINITION, options);
  return { path, fingerprint: REASONIX_TOOLCHAIN_FINGERPRINT };
}

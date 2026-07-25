import { createHash } from 'node:crypto';
import {
  prepareNodeCliToolchain,
  validatePreparedNodeCliToolchain,
  type PinnedNodeCliToolchainDefinition,
} from './node-cli-toolchain.js';

export const MAKA_NODE_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-node-toolchain';

export const MAKA_NODE_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  node: {
    version: '22.23.1',
    archiveUrl: 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz',
    archiveSha256: '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
    binarySha256: '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  },
} as const;

export const MAKA_NODE_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(MAKA_NODE_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedMakaNodeToolchain {
  path: string;
  fingerprint: typeof MAKA_NODE_TOOLCHAIN_FINGERPRINT;
}

const DEFINITION: PinnedNodeCliToolchainDefinition<typeof MAKA_NODE_TOOLCHAIN_SPEC> = {
  label: 'Maka Node runtime',
  fingerprint: MAKA_NODE_TOOLCHAIN_FINGERPRINT,
  spec: MAKA_NODE_TOOLCHAIN_SPEC,
  node: MAKA_NODE_TOOLCHAIN_SPEC.node,
  packageFiles: [],
};

export async function validatePreparedMakaNodeToolchain(
  path: string,
): Promise<PreparedMakaNodeToolchain> {
  await validatePreparedNodeCliToolchain(path, DEFINITION);
  return { path, fingerprint: MAKA_NODE_TOOLCHAIN_FINGERPRINT };
}

export async function prepareMakaNodeToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedMakaNodeToolchain> {
  await prepareNodeCliToolchain(path, DEFINITION, options);
  return { path, fingerprint: MAKA_NODE_TOOLCHAIN_FINGERPRINT };
}

import { createHash } from 'node:crypto';
import {
  prepareNodeCliToolchain,
  validatePreparedNodeCliToolchain,
  type PinnedNodeCliToolchainDefinition,
} from './node-cli-toolchain.js';

export const CODEX_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-codex-toolchain';
export const CODEX_DEEPSEEK_MODEL_CATALOG_FINGERPRINT =
  'sha256:faac5d862e0ce0bf5bcaccd515de04cf2dcd33cd38a53f0332fe2e8620ab7caa';

export const CODEX_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  node: {
    version: '22.23.1',
    archiveUrl: 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz',
    archiveSha256: '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
    binarySha256: '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  },
  codex: {
    version: '0.144.6',
    archiveUrl: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.6-linux-x64.tgz',
    archiveIntegrity:
      'sha512-4E7EnzCg0OnBxCyYnwJ+qnZwWHYe0YScr5ucKWbngE9u4+0XrpWELqq2Kn9jl5GZK8MDjU7PrJwFIwusHOHjuw==',
    files: {
      binary: 'a31ae9450a26216eb1e7c53102fd42123dd675974310b0e2ca3aa4cb622a2c15',
      codeModeHost: 'b3c1b98e0272ed4bff2bf0459574ff5489dee3087149648e43b1b665a76373e1',
      ripgrep: 'ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2',
      bubblewrap: '7df960565a0dece99240ea4b9d0e011307817f9f3b73176c7b71fda44fe84765',
      zsh: '67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3',
      packageMetadata: '4415fcb6e062b567abf79960dbbd38f046ce3c8fbb1170e35fd8129d476126d8',
    },
  },
} as const;

export const CODEX_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(CODEX_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedCodexToolchain {
  path: string;
  fingerprint: typeof CODEX_TOOLCHAIN_FINGERPRINT;
}

const DEFINITION: PinnedNodeCliToolchainDefinition<typeof CODEX_TOOLCHAIN_SPEC> = {
  label: 'Codex CLI',
  fingerprint: CODEX_TOOLCHAIN_FINGERPRINT,
  spec: CODEX_TOOLCHAIN_SPEC,
  node: CODEX_TOOLCHAIN_SPEC.node,
  packageArchive: {
    url: CODEX_TOOLCHAIN_SPEC.codex.archiveUrl,
    integrity: CODEX_TOOLCHAIN_SPEC.codex.archiveIntegrity,
  },
  packageFiles: [
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/bin/codex',
      installedPath: 'bin/codex',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.binary,
      executable: true,
      stripComponents: 4,
    },
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host',
      installedPath: 'bin/codex-code-mode-host',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.codeModeHost,
      executable: true,
      stripComponents: 4,
    },
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/codex-path/rg',
      installedPath: 'codex-path/rg',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.ripgrep,
      executable: true,
      stripComponents: 4,
    },
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap',
      installedPath: 'codex-resources/bwrap',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.bubblewrap,
      executable: true,
      stripComponents: 4,
    },
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/codex-resources/zsh/bin/zsh',
      installedPath: 'codex-resources/zsh/bin/zsh',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.zsh,
      executable: true,
      stripComponents: 6,
    },
    {
      archivePath: 'package/vendor/x86_64-unknown-linux-musl/codex-package.json',
      installedPath: 'codex-package.json',
      sha256: CODEX_TOOLCHAIN_SPEC.codex.files.packageMetadata,
      stripComponents: 3,
    },
  ],
};

export async function validatePreparedCodexToolchain(
  path: string,
): Promise<PreparedCodexToolchain> {
  await validatePreparedNodeCliToolchain(path, DEFINITION);
  return { path, fingerprint: CODEX_TOOLCHAIN_FINGERPRINT };
}

export async function prepareCodexToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedCodexToolchain> {
  await prepareNodeCliToolchain(path, DEFINITION, options);
  return { path, fingerprint: CODEX_TOOLCHAIN_FINGERPRINT };
}

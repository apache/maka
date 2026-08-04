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
    version: '0.146.0',
    archiveUrl: 'https://registry.npmjs.org/@openai/codex/-/codex-0.146.0-linux-x64.tgz',
    archiveIntegrity:
      'sha512-fswvyGprAPCMiOEue/7MKMk7pCjh9kZIJfJX5i9atmfnmGYbYCcUhZsEH9LEP0+0t5xyPqDbfNXY7NSxIVuXxA==',
    files: {
      binary: '2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04',
      codeModeHost: '520e0f7e2c955a591995c4437d6b10c38595c43c94fba39cef4381a00dadcb98',
      ripgrep: 'e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
      bubblewrap: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
      zsh: '67faaaa89242c4a332e16e508a1977cffc24bf7fca31d4411cdfd101f3831ef3',
      packageMetadata: '3f9cd79076d1747cba97f610475f3ad99be314a15cbf665b8d8f179c020aa353',
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

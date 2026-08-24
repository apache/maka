import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isTemporaryNpxInstallation } from './runtime-host-installation-provenance.js';

const PACKAGE_NAME = 'maka-agent';
const developmentGenerationId = randomUUID();

export interface RuntimeHostCliInstallationContext {
  readonly packageRoot: string;
  readonly version: string;
  readonly installationScope: 'persistent' | 'temporary_npx';
  readonly artifactGeneration: string;
}

export async function resolveRuntimeHostCliInstallationContext(
  options: {
    readonly manifestUrl?: URL;
    readonly developmentId?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
  } = {},
): Promise<RuntimeHostCliInstallationContext> {
  const manifestUrl = options.manifestUrl ?? new URL('../package.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    private?: unknown;
  };
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error('The Maka CLI installation manifest is invalid');
  }
  const packageRoot = fileURLToPath(new URL('.', manifestUrl));
  const provenance = manifest.private === true ? 'development' : 'release';
  const installationScope = (await isTemporaryNpxInstallation(packageRoot, {
    environment: options.environment ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  }))
    ? 'temporary_npx'
    : 'persistent';
  return {
    packageRoot,
    version: manifest.version,
    installationScope,
    artifactGeneration:
      provenance === 'release'
        ? `${PACKAGE_NAME}@${manifest.version}`
        : `${PACKAGE_NAME}@${manifest.version}+development.${options.developmentId ?? developmentGenerationId}`,
  };
}

let defaultInstallationContext: Promise<RuntimeHostCliInstallationContext> | undefined;

export function loadRuntimeHostCliInstallationContext(): Promise<RuntimeHostCliInstallationContext> {
  defaultInstallationContext ??= resolveRuntimeHostCliInstallationContext();
  return defaultInstallationContext;
}

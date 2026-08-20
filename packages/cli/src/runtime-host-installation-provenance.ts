import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function isTemporaryNpxInstallation(
  path: string,
  input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly homeDir: string;
  },
): Promise<boolean> {
  const canonicalPath = await realpath(path).catch(() => resolve(path));
  const cacheRoots = await Promise.all(
    [input.environment.npm_config_cache, join(input.homeDir, '.npm')].flatMap((root) =>
      root ? [realpath(resolve(root, '_npx')).catch(() => resolve(root, '_npx'))] : [],
    ),
  );
  return cacheRoots.some((root) => isWithin(root, canonicalPath));
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

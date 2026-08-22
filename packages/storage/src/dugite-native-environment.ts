import { posix, win32 } from 'node:path';

export interface BundledGitEnvironmentInput {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly rootPath: string;
  readonly executablePath: string;
}

export function bundledGitEnvironment(input: BundledGitEnvironmentInput): NodeJS.ProcessEnv {
  const path = input.platform === 'win32' ? win32 : posix;
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(input.executablePath),
  };
  if (input.platform === 'win32') {
    const platformRoot = path.join(
      input.rootPath,
      input.arch === 'x64' ? 'mingw64' : input.arch === 'arm64' ? 'clangarm64' : 'mingw32',
    );
    env.PATH = [
      path.dirname(input.executablePath),
      path.join(platformRoot, 'bin'),
      path.join(platformRoot, 'usr', 'bin'),
    ].join(';');
    env.GIT_EXEC_PATH = path.join(platformRoot, 'libexec', 'git-core');
    return env;
  }
  env.GIT_EXEC_PATH = path.join(input.rootPath, 'libexec', 'git-core');
  env.GIT_TEMPLATE_DIR = path.join(input.rootPath, 'share', 'git-core', 'templates');
  if (input.platform === 'linux') {
    env.PREFIX = input.rootPath;
    env.GIT_SSL_CAINFO = path.join(input.rootPath, 'ssl', 'cacert.pem');
  }
  return env;
}

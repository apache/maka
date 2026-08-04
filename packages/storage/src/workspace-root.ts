import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface ResolveMakaWorkspaceRootInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  workspaceName?: string;
}

export function resolveMakaWorkspaceRoot(input: ResolveMakaWorkspaceRootInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.homeDir ?? homedir();
  const workspaceName = input.workspaceName ?? 'default';
  const userDataRoot = resolveElectronUserDataRoot(platform, env, home);
  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi.join(userDataRoot, 'workspaces', workspaceName);
}

function resolveElectronUserDataRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'Maka');
  }
  if (platform === 'win32') {
    return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), 'Maka');
  }
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'Maka');
}

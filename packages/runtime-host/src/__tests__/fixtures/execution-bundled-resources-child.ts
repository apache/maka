import { resolveExecutionBundledResourcesRoot } from '../../server/execution-bundled-resources.js';

if (!process.versions.electron) {
  throw new Error('execution bundled resources fixture requires Electron Node mode');
}

const electronProcess = process as NodeJS.Process & {
  readonly defaultApp?: boolean;
  readonly resourcesPath?: string;
};

process.stdout.write(
  `${JSON.stringify({
    defaultApp: electronProcess.defaultApp ?? null,
    resourcesPath: electronProcess.resourcesPath ?? null,
    resolved:
      resolveExecutionBundledResourcesRoot({
        electronVersion: process.versions.electron,
        defaultApp: electronProcess.defaultApp,
        resourcesPath: electronProcess.resourcesPath,
      }) ?? null,
  })}\n`,
);

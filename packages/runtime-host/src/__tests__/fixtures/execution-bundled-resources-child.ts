import { resolveExecutionBundledResourcesRoot } from '../../server/execution-bundled-resources.js';
import { issueDesktopPackagedCandidateAuthority } from '../../client/packaged-candidate-authority.js';

if (!process.versions.electron) {
  throw new Error('execution bundled resources fixture requires Electron Node mode');
}

const electronProcess = process as NodeJS.Process & {
  readonly defaultApp?: boolean;
  readonly resourcesPath?: string;
};
const authority = await issueDesktopPackagedCandidateAuthority();

process.stdout.write(
  `${JSON.stringify({
    defaultApp: electronProcess.defaultApp ?? null,
    resourcesPath: electronProcess.resourcesPath ?? null,
    authorityIssued: authority !== undefined,
    resolved:
      resolveExecutionBundledResourcesRoot({
        electronVersion: process.versions.electron,
        defaultApp: electronProcess.defaultApp,
        resourcesPath: electronProcess.resourcesPath,
      }) ?? null,
  })}\n`,
);

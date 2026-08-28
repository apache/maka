/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMakaDataRoots, resolveMakaDataRoots } from './workspace-root.js';
import {
  configureRuntimeHostPeerClient,
  resolveRuntimeHostPeerNativePath,
} from './runtime-host-peer-artifact.js';
import {
  parseRuntimeHostCommand,
  parseRuntimeHostInstalledUpdateCommand,
  type RuntimeHostCliCommand,
} from './runtime-host-cli.js';
import { resolveCliUiLocale } from './cli-ui-locale.js';

export type MakaCliCommand =
  | {
      kind: 'tui';
      resumeSessionId?: string;
      resumeCwd?: string;
      hostProfileId?: string;
      projectId?: string;
    }
  | { kind: 'run'; args: string[] }
  | { kind: 'activate'; args: string[] }
  | { kind: 'eval'; args: string[] }
  | { kind: 'acp' }
  | RuntimeHostCliCommand
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'error'; message: string; exitCode: number; showHelp?: boolean };

export interface MakaCliLaunchOptions {
  readonly dataProfileName: string;
  readonly cliCommand: string;
  readonly capabilityProviderIdentityScope: 'legacy-home' | 'client-data-root';
}

export const RELEASE_MAKA_CLI_LAUNCH_OPTIONS = {
  dataProfileName: 'Maka',
  cliCommand: 'maka',
  capabilityProviderIdentityScope: 'legacy-home',
} satisfies MakaCliLaunchOptions;

export function parseMakaCliArgs(
  argv: string[],
  version: string,
  cliCommand = RELEASE_MAKA_CLI_LAUNCH_OPTIONS.cliCommand,
): MakaCliCommand {
  if (argv.length === 0) return { kind: 'tui' };
  const [first] = argv;
  if (first === '--help' || first === '-h') return { kind: 'help', text: helpText(cliCommand) };
  if (first === '--version' || first === '-v') return { kind: 'version', text: version };
  if (first === '--acp') {
    return argv.length === 1
      ? { kind: 'acp' }
      : {
          kind: 'error',
          message: 'maka --acp does not accept arguments',
          exitCode: 2,
          showHelp: false,
        };
  }
  if (first?.startsWith('--')) return parseTuiArgs(argv);
  if (first === 'run' || first === '-p') return { kind: 'run', args: argv.slice(1) };
  if (first === 'activate') return { kind: 'activate', args: argv.slice(1) };
  if (first === 'eval') return { kind: 'eval', args: argv.slice(1) };
  if (first === 'update') return parseRuntimeHostInstalledUpdateCommand(argv.slice(1));
  if (first === 'runtime-host') return parseRuntimeHostCommand(argv.slice(1));
  return {
    kind: 'error',
    message: `Unexpected argument: ${first ?? ''}`,
    exitCode: 2,
  };
}

export function resolveMakaCliExitCode(
  commandExitCode: number,
  pendingExitCode: number | string | null | undefined,
): number | string {
  return pendingExitCode === undefined || pendingExitCode === null || pendingExitCode === 0
    ? commandExitCode
    : pendingExitCode;
}

export function formatMakaCliFatalError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

let processExitTimer: NodeJS.Timeout | undefined;

export function beginMakaCliExit(commandExitCode: number): void {
  const exitCode = resolveMakaCliExitCode(commandExitCode, process.exitCode);
  process.exitCode = exitCode;
  if (processExitTimer) return;
  processExitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), PROCESS_EXIT_GRACE_MS);
  processExitTimer.unref();
}

export function handleMakaCliProcessExit(
  exitCode: number,
  error?: unknown,
  writeFatal: (message: string) => unknown = (message) => process.stderr.write(message),
): void {
  beginMakaCliExit(exitCode);
  if (error) writeFatal(`${formatMakaCliFatalError(error)}\n`);
}

function helpText(cliCommand: string): string {
  return [
    `Usage: ${cliCommand}`,
    '',
    'Launches the Maka terminal UI in the current working directory.',
    '',
    'Commands:',
    `  ${cliCommand}              Start the TUI`,
    `  ${cliCommand} --acp      Serve ACP v1 over stdio (initialize only; session support in progress)`,
    `  ${cliCommand} run ...      Run one non-interactive model turn`,
    `  ${cliCommand} activate ... Run one Cloud Session activation and emit JSONL`,
    `  ${cliCommand} -p ...       Alias for ${cliCommand} run`,
    `  ${cliCommand} eval ...     Run one declarative multi-arm experiment`,
    `  ${cliCommand} update --target <latest|next|version>  Update this npm-global CLI and its local Runtime Host`,
    `  ${cliCommand} runtime-host serve [options]  Run a Runtime Host service`,
    `  ${cliCommand} runtime-host activate --framed --root-id <id>`,
    `  ${cliCommand} runtime-host setup --principal <id> --preset <desktop-client|terminal-client> [options]`,
    `  ${cliCommand} runtime-host service install [options]`,
    `  ${cliCommand} runtime-host service configure (--project-root <label>=<path> ... | --no-project-roots) --expected-config-fingerprint <sha256:...> --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
    `  ${cliCommand} runtime-host service status|start|stop|restart|logs [--json]`,
    `  ${cliCommand} runtime-host service uninstall --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
    `  ${cliCommand} runtime-host service peer enable|disable|status|rotate|descriptor [options]`,
    `  ${cliCommand} runtime-host service retire --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
    `  ${cliCommand} runtime-host service check-update --target <latest|next|version> [--json]`,
    `  ${cliCommand} runtime-host service update [--target <latest|next|version>] --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
    `  ${cliCommand} runtime-host service update-policy [--target <manual|latest|next|version>] [--json]`,
    `  ${cliCommand} runtime-host service reconcile-update [--json]`,
    `  ${cliCommand} runtime-host access issue --principal <id> --grant <operation>`,
    `  ${cliCommand} runtime-host access issue --principal <id> --preset <desktop-client|terminal-client>`,
    `  ${cliCommand} runtime-host access list`,
    `  ${cliCommand} runtime-host access issue --kind capability-provider --principal <id>`,
    `  ${cliCommand} runtime-host access revoke --credential <id>`,
    `  ${cliCommand} runtime-host project list [--root <path>]`,
    `  ${cliCommand} runtime-host project add <path> [--prefer] [--root <path>]`,
    `  ${cliCommand} runtime-host profile list`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --tls-url <wss-url> --expected-root <root-id> [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --ssh-destination <user@host> --ssh-remote-port <port> --expected-root <root-id> [--ssh-port <port>] [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --plaintext-url <ws-url> --acknowledge-plaintext --expected-root <root-id> [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --peer-id <peer-id> --peer-route <multiaddr> --expected-root <root-id> [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile remove --id <id>`,
    `  ${cliCommand} runtime-host capability-provider serve --url <ws-url> --mcp-config <path> --expected-root <root-id>`,
    '',
    'Options:',
    '  -h, --help        Show help',
    '  -v, --version     Show version',
    '  --resume <session-id>  Reopen a previous session in the TUI',
    '  --resume <id> --cwd <path>  Reopen a session after its directory moved',
    '  --host <profile-id>     Connect the TUI to a saved Runtime Host profile',
    '  --project <project-id>  Select an existing Project on a remote Host',
    '  MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL  Access credential used by runtime-host profile set',
    '',
    'Runtime Host serve options:',
    '  --root <path>                 Select the canonical data root',
    '  --project-root <label>=<path> Publish an absolute project directory root (repeatable)',
    '  --no-project-roots            Disable remote project browsing and registration',
    '  --websocket-port <port>       Enable an authenticated WebSocket listener',
    '  --websocket-host <host>       Bind host (default: 127.0.0.1)',
    '  --websocket-path <path>       Upgrade path (default: /runtime-host)',
    '  --tls-certificate <path>      TLS certificate for WSS',
    '  --tls-private-key <path>      TLS private key for WSS',
    '  --allow-insecure-remote       Allow plaintext WebSocket access beyond loopback',
    '  --allow-origin <origin>       Allow one browser Origin (repeatable)',
    '  --peer-native-path <path>     Load the experimental direct-peer native module',
    '  --peer-key <path>             Persist the direct-peer transport identity',
    '  --peer-id <id>                Require an existing direct-peer transport identity',
    '  --peer-listen <multiaddr>     Listen on a direct-peer address (repeatable)',
    '  --peer-coordination-relay <multiaddr>  Use a DCUtR coordination relay (repeatable)',
    '  --json                        Emit one machine-readable ready event',
    '',
    'Managed Runtime Host service install options (Linux or macOS):',
    '  --root <path>                 Select the canonical data root',
    '  --project-root <label>=<path> Publish an absolute directory root (repeatable)',
    '  --no-project-roots            Disable remote project browsing and registration',
    '  --websocket-port <port>       Persist a loopback port (chosen automatically by default)',
    '  --websocket-path <path>       Persist the upgrade path (default: /runtime-host)',
    '  --json                        Emit a machine-readable result',
    '',
    'Managed Runtime Host setup options (Linux or macOS):',
    '  --principal <id>              Stable Client pairing identity',
    '  --preset <name>               Pair a desktop-client or terminal-client',
    '  --root <path>                 Select the canonical data root',
    '  --project-root <label>=<path> Publish an absolute directory root (repeatable)',
    '  --no-project-roots            Disable remote project browsing and registration',
    '  --websocket-port <port>       Persist a loopback port (chosen automatically by default)',
    '  --websocket-path <path>       Persist the upgrade path (default: /runtime-host)',
    '  --json                        Emit framed machine-readable progress and result records',
    '',
    'Runtime Host access issue options:',
    '  --root <path>                 Select the canonical data root',
    '  --kind <kind>                 remote-owner or capability-provider',
    '  --principal <id>              Name the authenticated Client principal',
    '  --grant <operation>           Grant one exact operation (repeatable)',
    '  --preset <name>               Grant the desktop-client or terminal-client operation set',
    '  --publish-client-capabilities Allow Client Capability publication',
    '  --allow-host-paths            Allow operations that submit Host paths',
    '',
    'Runtime Host capability provider options:',
    '  --url <ws-url>                Connect to an authenticated Runtime Host WebSocket',
    '  --mcp-config <path>           Publish tools from an MCP configuration file',
    '  --expected-root <root-id>     Pin the canonical Runtime Host root identity',
    '  --credential-env <name>       Read the access credential from this environment variable',
    '  --client-identity <path>      Persist the provider Client instance identity here',
  ].join('\n');
}

export async function runMakaCli(
  argv: string[] = process.argv.slice(2),
  options: MakaCliLaunchOptions = RELEASE_MAKA_CLI_LAUNCH_OPTIONS,
): Promise<number> {
  const version = await readPackageVersion();
  const command = parseMakaCliArgs(argv, version, options.cliCommand);
  const dataRoots = resolveMakaDataRoots({
    profileName: options.dataProfileName,
  });
  await configureRuntimeHostPeerClient({
    cliPath: process.argv[1] ?? '',
    clientDataRoot: dataRoots.clientDataRoot,
  });
  switch (command.kind) {
    case 'runtime-host-managed-activate': {
      const { runRuntimeHostManagedActivationCli } = await import(
        './runtime-host-activation-command.js'
      );
      return runRuntimeHostManagedActivationCli({
        rootId: command.rootId,
        ...(command.repairRootAfterRemount ? { repairRootAfterRemount: true } : {}),
      });
    }
    case 'runtime-host-managed-connect': {
      const { runRuntimeHostManagedConnectCli } = await import('./runtime-host-connect-command.js');
      return runRuntimeHostManagedConnectCli({
        rootId: command.rootId,
        ...(command.repairRootAfterRemount ? { repairRootAfterRemount: true } : {}),
      });
    }
    case 'run': {
      const { runRuntimeHostTextCli } = await import('./runtime-host-run-command.js');
      return runRuntimeHostTextCli(
        command.args,
        { workspaceRoot: () => dataRoots.workspaceRoot },
        {},
        {
          clientDataRoot: dataRoots.clientDataRoot,
          cliCommand: options.cliCommand,
        },
      );
    }
    case 'activate': {
      const { runMakaActivationCli } = await import('./activation-command.js');
      return runMakaActivationCli(command.args);
    }
    case 'eval': {
      const { configureInstalledEvalBundle } = await import('./eval-bundle-path.js');
      configureInstalledEvalBundle();
      const { runMakaEvalCli } = await import('@maka/eval');
      return runMakaEvalCli(command.args);
    }
    case 'acp': {
      const { runMakaAcpStdioServer } = await import('./acp/stdio-server.js');
      return runMakaAcpStdioServer({ version });
    }
    case 'runtime-host-serve': {
      const { runRuntimeHostServiceCli } = await import('./runtime-host-service-command.js');
      if (command.managedDeployment) {
        const { resolveRuntimeHostManagedDeployment, resolveRuntimeHostNpmDeploymentLayout } =
          await import('@maka/runtime-host/operator');
        const { config } = await resolveRuntimeHostManagedDeployment(
          command.managedDeployment.rootId,
        );
        const peer = config.listeners.directPeer?.enabled ? config.listeners.directPeer : undefined;
        const packageLayout = resolveRuntimeHostNpmDeploymentLayout(
          config.deploymentRoot,
          config.launch.package.integrity,
        );
        return runRuntimeHostServiceCli({
          rootPath: config.root.path,
          json: command.json,
          managedLaunchClaim: {
            deploymentId: command.managedDeployment.deploymentId,
            configRevision: command.managedDeployment.configRevision,
          },
          projectDirectoryRoots: config.projectDirectoryRoots,
          ...(config.listeners.websocket ? { websocket: config.listeners.websocket } : {}),
          ...(peer
            ? {
                peer: {
                  nativePath: await resolveRuntimeHostPeerNativePath(packageLayout.cliPath),
                  keyPath: peer.keyPath,
                  expectedPeerId: peer.peerId,
                  listenAddresses: peer.listenAddresses,
                  coordinationRelays: peer.coordinationRelays,
                },
              }
            : {}),
        });
      }
      if (command.managedServiceConfigPath) {
        const { effectiveRuntimeHostProjectDirectoryRoots, readRuntimeHostManagedServiceConfig } =
          await import('./runtime-host-service-manager.js');
        const config = await readRuntimeHostManagedServiceConfig(command.managedServiceConfigPath);
        return runRuntimeHostServiceCli({
          rootPath: config.rootPath,
          json: command.json,
          projectDirectoryRoots: effectiveRuntimeHostProjectDirectoryRoots(config),
          websocket: config.websocket,
        });
      }
      return runRuntimeHostServiceCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        json: command.json,
        ...(command.projectDirectoryRoots
          ? { projectDirectoryRoots: command.projectDirectoryRoots }
          : {}),
        ...(command.websocket ? { websocket: command.websocket } : {}),
        ...(command.peer ? { peer: command.peer } : {}),
      });
    }
    case 'runtime-host-installed-update': {
      const { runRuntimeHostInstalledUpdateBootstrap } = await import(
        './runtime-host-installed-update-bootstrap.js'
      );
      return runRuntimeHostInstalledUpdateBootstrap({
        rootPath: dataRoots.workspaceRoot,
        selector: command.selector,
        allowInterruptActiveTasks: command.allowInterruptActiveTasks,
      });
    }
    case 'runtime-host-local-update-apply': {
      const { runRuntimeHostInstalledUpdateCoordinator } = await import(
        './runtime-host-installed-update-coordinator.js'
      );
      return runRuntimeHostInstalledUpdateCoordinator({
        rootPath: command.rootPath,
        archivePath: command.archivePath,
        installedPackageRoot: command.installedPackageRoot,
        installedCliPath: command.installedCliPath,
        currentVersion: command.currentVersion,
        target: {
          kind: 'npm_registry',
          version: command.targetVersion,
          integrity: command.targetIntegrity,
          ...(command.targetCompatibility === undefined
            ? {}
            : { compatibility: command.targetCompatibility }),
        },
        allowInterruptActiveTasks: command.allowInterruptActiveTasks,
      });
    }
    case 'runtime-host-local-update-activate': {
      const { runRuntimeHostInstalledUpdateActivator } = await import(
        './runtime-host-installed-update-activator.js'
      );
      return runRuntimeHostInstalledUpdateActivator({
        rootPath: command.rootPath,
        expectedRootId: command.expectedRootId,
        generation: command.generation,
        candidateEntrypoint: command.candidateEntrypoint,
        awaitCoordinatorCommit: command.awaitCoordinatorCommit,
        ...(command.takeoverHostEpoch ? { takeoverHostEpoch: command.takeoverHostEpoch } : {}),
        ...(command.expectedOwnerInstallationId
          ? { expectedOwnerInstallationId: command.expectedOwnerInstallationId }
          : {}),
        ...(command.targetVersion ? { targetVersion: command.targetVersion } : {}),
        ...(command.targetIntegrity ? { targetIntegrity: command.targetIntegrity } : {}),
        ...(command.awaitCoordinatorCommit ? { inheritableAuthorityLeaseFd: 4 } : {}),
      });
    }
    case 'runtime-host-setup': {
      const { runRuntimeHostSetupCli } = await import('./runtime-host-setup-command.js');
      const { RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV } = await import(
        '@maka/runtime-host/operator'
      );
      return runRuntimeHostSetupCli({
        json: command.json,
        clientDataRoot: command.clientDataRoot ?? dataRoots.clientDataRoot,
        defaultRootPath: dataRoots.workspaceRoot,
        sourcePackageRoot: fileURLToPath(new URL('..', import.meta.url)),
        version,
        sourcePackageIntegrity: process.env[RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV],
        principalId: command.principalId,
        preset: command.preset,
        lifecycle: command.lifecycle,
        deferPairingCommit: command.deferPairingCommit,
        bindPairingToClient: command.bindPairingToClient,
        ...(command.repairRootAfterRemount ? { repairRootAfterRemount: true } : {}),
        updateExisting: command.updateExisting,
        ...(command.rootPath ? { rootPath: command.rootPath } : {}),
        ...(command.projectDirectoryRoots
          ? { projectDirectoryRoots: command.projectDirectoryRoots }
          : {}),
        ...(command.websocketPort === undefined ? {} : { websocketPort: command.websocketPort }),
        ...(command.websocketPath ? { websocketPath: command.websocketPath } : {}),
        ...(command.directPeer ? { directPeer: command.directPeer } : {}),
        ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
      });
    }
    case 'runtime-host-service-manage': {
      const { runManagedRuntimeHostServiceCli } = await import(
        './runtime-host-service-management-command.js'
      );
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      return runManagedRuntimeHostServiceCli({
        action: command.action,
        json: command.json,
        framed: command.framed ?? false,
        clientDataRoot: serviceDataRoots.clientDataRoot,
        defaultRootPath: serviceDataRoots.workspaceRoot,
        nodePath: process.execPath,
        cliPath: process.argv[1] ?? '',
        ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
        ...(command.operatorDeploymentId
          ? { operatorDeploymentId: command.operatorDeploymentId }
          : {}),
        ...(command.rootPath ? { rootPath: command.rootPath } : {}),
        ...(command.projectDirectoryRoots
          ? { projectDirectoryRoots: command.projectDirectoryRoots }
          : {}),
        ...(command.websocketPort === undefined ? {} : { websocketPort: command.websocketPort }),
        ...(command.websocketPath ? { websocketPath: command.websocketPath } : {}),
        ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
        ...(command.expectedConfigFingerprint
          ? { expectedConfigFingerprint: command.expectedConfigFingerprint }
          : {}),
        ...(command.retainManagedDeployment ? { retainManagedDeployment: true } : {}),
        ...(command.allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
      });
    }
    case 'runtime-host-service-peer': {
      const { runRuntimeHostPeerManagementCli } = await import(
        './runtime-host-peer-management-command.js'
      );
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      return runRuntimeHostPeerManagementCli({
        action: command.action,
        json: command.json,
        framed: command.framed ?? false,
        clientDataRoot: serviceDataRoots.clientDataRoot,
        defaultRootPath: serviceDataRoots.workspaceRoot,
        nodePath: process.execPath,
        cliPath: process.argv[1] ?? '',
        managedRootId: command.managedRootId,
        operatorDeploymentId: command.operatorDeploymentId,
        listenAddresses: command.listenAddresses,
        ...(command.coordinationRelays ? { coordinationRelays: command.coordinationRelays } : {}),
        ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
        ...(command.allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
      });
    }
    case 'runtime-host-service-update': {
      const { runManagedRuntimeHostSelectedUpdateCli, runManagedRuntimeHostUpdateCli } =
        await import('./runtime-host-update-command.js');
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      if (command.selector) {
        return runManagedRuntimeHostSelectedUpdateCli({
          json: command.json,
          framed: command.framed ?? false,
          clientDataRoot: serviceDataRoots.clientDataRoot,
          defaultRootPath: serviceDataRoots.workspaceRoot,
          selector: command.selector,
          expectedTarget: command.expectedTarget,
          ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
          ...(command.operatorDeploymentId
            ? { operatorDeploymentId: command.operatorDeploymentId }
            : {}),
          ...(command.allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
        });
      }
      return runManagedRuntimeHostUpdateCli({
        json: command.json,
        framed: command.framed ?? false,
        clientDataRoot: serviceDataRoots.clientDataRoot,
        defaultRootPath: serviceDataRoots.workspaceRoot,
        sourcePackageRoot: fileURLToPath(new URL('..', import.meta.url)),
        version,
        expectedTarget: command.expectedTarget,
        ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
        ...(command.operatorDeploymentId
          ? { operatorDeploymentId: command.operatorDeploymentId }
          : {}),
        ...(command.allowInterruptActiveTasks ? { allowInterruptActiveTasks: true } : {}),
      });
    }
    case 'runtime-host-service-check-update': {
      const { runManagedRuntimeHostUpdateCheckCli } = await import(
        './runtime-host-update-discovery.js'
      );
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      return runManagedRuntimeHostUpdateCheckCli({
        json: command.json,
        framed: command.framed ?? false,
        clientDataRoot: serviceDataRoots.clientDataRoot,
        defaultRootPath: serviceDataRoots.workspaceRoot,
        selector: command.selector,
        ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
        ...(command.operatorDeploymentId
          ? { operatorDeploymentId: command.operatorDeploymentId }
          : {}),
        ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
      });
    }
    case 'runtime-host-service-update-policy':
    case 'runtime-host-service-reconcile-update': {
      const { runManagedRuntimeHostUpdatePolicyCli, runManagedRuntimeHostUpdateReconcileCli } =
        await import('./runtime-host-update-reconciliation.js');
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      if (command.kind === 'runtime-host-service-update-policy') {
        return runManagedRuntimeHostUpdatePolicyCli({
          json: command.json,
          framed: command.framed ?? false,
          clientDataRoot: serviceDataRoots.clientDataRoot,
          defaultRootPath: serviceDataRoots.workspaceRoot,
          ...(command.policy ? { policy: command.policy } : {}),
          ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
          ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
          ...(command.operatorDeploymentId
            ? { operatorDeploymentId: command.operatorDeploymentId }
            : {}),
        });
      }
      return runManagedRuntimeHostUpdateReconcileCli({
        json: command.json,
        framed: command.framed ?? false,
        clientDataRoot: serviceDataRoots.clientDataRoot,
        defaultRootPath: serviceDataRoots.workspaceRoot,
        ...(command.expectedTarget ? { expectedTarget: command.expectedTarget } : {}),
        ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
        ...(command.operatorDeploymentId
          ? { operatorDeploymentId: command.operatorDeploymentId }
          : {}),
      });
    }
    case 'runtime-host-managed-deployment-cleanup': {
      const { runManagedRuntimeHostDeploymentCleanupCli } = await import(
        './runtime-host-service-management-command.js'
      );
      const serviceDataRoots = command.clientDataRoot
        ? deriveMakaDataRoots(command.clientDataRoot)
        : dataRoots;
      return runManagedRuntimeHostDeploymentCleanupCli({
        clientDataRoot: serviceDataRoots.clientDataRoot,
        cliPath: process.argv[1] ?? '',
        ...(command.managedRootId ? { managedRootId: command.managedRootId } : {}),
        ...(command.operatorDeploymentId
          ? { operatorDeploymentId: command.operatorDeploymentId }
          : {}),
        ...(command.finalize ? { finalize: true } : {}),
        expectedTarget: command.expectedTarget,
      });
    }
    case 'runtime-host-access-issue': {
      const { runRuntimeHostAccessIssueCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessIssueCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        ...(command.expectedRootId ? { expectedRootId: command.expectedRootId } : {}),
        principalKind: command.principalKind,
        principalId: command.principalId,
        operationGrants: command.operationGrants,
        canPublishClientCapabilities: command.canPublishClientCapabilities,
        canUseHostPaths: command.canUseHostPaths,
        ...(command.preset ? { preset: command.preset } : {}),
      });
    }
    case 'runtime-host-access-prepare': {
      const { runRuntimeHostAccessPrepareCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessPrepareCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        ...(command.expectedRootId ? { expectedRootId: command.expectedRootId } : {}),
        currentCredentialFingerprint: command.currentCredentialFingerprint,
      });
    }
    case 'runtime-host-access-list': {
      const { runRuntimeHostAccessListCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessListCli(
        {
          rootPath: command.rootPath ?? dataRoots.workspaceRoot,
          ...(command.expectedRootId ? { expectedRootId: command.expectedRootId } : {}),
        },
        command.framed,
      );
    }
    case 'runtime-host-access-revoke': {
      const { runRuntimeHostAccessRevokeCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessRevokeCli(
        {
          rootPath: command.rootPath ?? dataRoots.workspaceRoot,
          ...(command.expectedRootId ? { expectedRootId: command.expectedRootId } : {}),
          credentialId: command.credentialId,
          ...(command.currentCredentialFingerprint
            ? {
                currentCredentialFingerprint: command.currentCredentialFingerprint,
              }
            : {}),
        },
        command.framed,
      );
    }
    case 'runtime-host-project-list':
    case 'runtime-host-project-add': {
      const { runRuntimeHostProjectCli } = await import('./runtime-host-project-command.js');
      const rootPath = command.rootPath ?? dataRoots.workspaceRoot;
      return command.kind === 'runtime-host-project-list'
        ? runRuntimeHostProjectCli({ kind: 'list', rootPath })
        : runRuntimeHostProjectCli({
            kind: 'add',
            rootPath,
            path: command.path,
            prefer: command.prefer,
          });
    }
    case 'runtime-host-capability-provider-serve': {
      const { runRuntimeHostCapabilityProviderCli } = await import(
        './runtime-host-capability-provider-command.js'
      );
      return runRuntimeHostCapabilityProviderCli({
        url: command.url,
        mcpConfigPath: command.mcpConfigPath,
        expectedRootId: command.expectedRootId,
        ...(options.capabilityProviderIdentityScope === 'client-data-root'
          ? {
              defaultClientIdentityRoot: join(
                dataRoots.clientDataRoot,
                'runtime-host-capability-providers',
              ),
            }
          : {}),
        ...(command.credentialEnv ? { credentialEnv: command.credentialEnv } : {}),
        ...(command.clientIdentityPath ? { clientIdentityPath: command.clientIdentityPath } : {}),
      });
    }
    case 'runtime-host-profile-list':
    case 'runtime-host-profile-set':
    case 'runtime-host-profile-set-environment':
    case 'runtime-host-profile-remove': {
      const { runRuntimeHostProfileCommand } = await import('./runtime-host-profile-command.js');
      const profileOptions = { clientDataRoot: dataRoots.clientDataRoot };
      if (command.kind === 'runtime-host-profile-list') {
        return runRuntimeHostProfileCommand({ kind: 'list' }, {}, profileOptions);
      }
      if (command.kind === 'runtime-host-profile-remove') {
        return runRuntimeHostProfileCommand({ kind: 'remove', id: command.id }, {}, profileOptions);
      }
      if (command.kind === 'runtime-host-profile-set-environment') {
        return runRuntimeHostProfileCommand(
          {
            kind: 'set-environment',
            id: command.id,
            name: command.name,
            distribution: command.distribution,
            operatorPath: command.operatorPath,
            expectedRootId: command.expectedRootId,
          },
          {},
          profileOptions,
        );
      }
      return runRuntimeHostProfileCommand(
        {
          kind: 'set',
          id: command.id,
          name: command.name,
          transport: command.transport,
          expectedRootId: command.expectedRootId,
          ...(command.credentialEnv ? { credentialEnv: command.credentialEnv } : {}),
        },
        {},
        profileOptions,
      );
    }
    case 'help':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'version':
      process.stdout.write(`${command.text}\n`);
      return 0;
    case 'error':
      process.stderr.write(
        'showHelp' in command && command.showHelp === false
          ? `${command.message}\n`
          : `${command.message}\n\n${helpText(options.cliCommand)}\n`,
      );
      return command.exitCode;
    case 'tui': {
      const locale = resolveCliUiLocale(process.env);
      if (!locale.ok) {
        process.stderr.write(`${locale.message}\n`);
        return 2;
      }
      const { runRuntimeHostTui } = await import('./runtime-host-tui-command.js');
      return runRuntimeHostTui({
        cliCommand: options.cliCommand,
        clientDataRoot: dataRoots.clientDataRoot,
        workspaceRoot: dataRoots.workspaceRoot,
        locale: locale.locale,
        cwd: process.cwd(),
        onProcessExit: handleMakaCliProcessExit,
        ...(command.resumeSessionId ? { resumeSessionId: command.resumeSessionId } : {}),
        ...(command.resumeCwd ? { resumeCwd: command.resumeCwd } : {}),
        ...(command.hostProfileId ? { hostProfileId: command.hostProfileId } : {}),
        ...(command.projectId ? { projectId: command.projectId } : {}),
      });
    }
  }
}

function parseTuiArgs(argv: string[]): MakaCliCommand {
  const values = new Map<string, string>();
  const supported = new Set(['--resume', '--cwd', '--host', '--project']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option || !supported.has(option)) {
      return {
        kind: 'error',
        message: `Unexpected argument: ${option ?? ''}`,
        exitCode: 2,
      };
    }
    if (values.has(option)) {
      return {
        kind: 'error',
        message: `Option repeated: ${option}`,
        exitCode: 2,
      };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      const expected =
        option === '--resume' ? 'a session id' : option === '--cwd' ? 'a directory' : 'a value';
      return {
        kind: 'error',
        message: `${option} requires ${expected}`,
        exitCode: 2,
      };
    }
    values.set(option, value);
    index += 1;
  }
  if (values.has('--cwd') && !values.has('--resume')) {
    return { kind: 'error', message: '--cwd requires --resume', exitCode: 2 };
  }
  if (values.has('--project') && values.has('--resume')) {
    return {
      kind: 'error',
      message: '--project cannot be used with --resume',
      exitCode: 2,
    };
  }
  if (values.has('--cwd') && values.has('--host') && values.get('--host') !== 'local') {
    return {
      kind: 'error',
      message: '--cwd cannot be used with a remote Runtime Host',
      exitCode: 2,
    };
  }
  return {
    kind: 'tui',
    ...(values.has('--resume') ? { resumeSessionId: values.get('--resume') } : {}),
    ...(values.has('--cwd') ? { resumeCwd: values.get('--cwd') } : {}),
    ...(values.has('--host') ? { hostProfileId: values.get('--host') } : {}),
    ...(values.has('--project') ? { projectId: values.get('--project') } : {}),
  };
}

async function readPackageVersion(): Promise<string> {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

export function launchMakaCli(options: MakaCliLaunchOptions): void {
  runMakaCli(process.argv.slice(2), options).then(
    (code) => {
      beginMakaCliExit(code);
    },
    (error) => {
      handleMakaCliProcessExit(1, error);
    },
  );
}

// ShellRun escalates SIGTERM to SIGKILL after two seconds. Keep the CLI alive
// long enough for that cleanup to finish before the final process fallback.
const PROCESS_EXIT_GRACE_MS = 3_000;

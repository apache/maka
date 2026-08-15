#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMakaResumeHint } from './cli-invocation.js';
import { resolveMakaDataRoots } from './workspace-root.js';
import { parseRuntimeHostCommand, type RuntimeHostCliCommand } from './runtime-host-cli.js';

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
  | RuntimeHostCliCommand
  | { kind: 'help'; text: string }
  | { kind: 'version'; text: string }
  | { kind: 'error'; message: string; exitCode: number };

export interface MakaCliLaunchOptions {
  readonly dataProfileName: string;
  readonly cliCommand: string;
  readonly capabilityProviderIdentityScope: 'legacy-home' | 'client-data-root';
}

const RELEASE_MAKA_CLI_LAUNCH_OPTIONS = {
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
  if (first?.startsWith('--')) return parseTuiArgs(argv);
  if (first === 'run' || first === '-p') return { kind: 'run', args: argv.slice(1) };
  if (first === 'activate') return { kind: 'activate', args: argv.slice(1) };
  if (first === 'eval') return { kind: 'eval', args: argv.slice(1) };
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
    ...(cliCommand === 'maka' ? ['  maka-agent        Start the TUI'] : []),
    `  ${cliCommand} run ...      Run one non-interactive model turn`,
    `  ${cliCommand} activate ... Run one Cloud Session activation and emit JSONL`,
    `  ${cliCommand} -p ...       Alias for ${cliCommand} run`,
    `  ${cliCommand} eval ...     Run one declarative multi-arm experiment`,
    `  ${cliCommand} runtime-host serve [options]  Run a Runtime Host service`,
    `  ${cliCommand} runtime-host access issue --principal <id> --grant <operation>`,
    `  ${cliCommand} runtime-host access issue --principal <id> --preset <desktop-client|terminal-client>`,
    `  ${cliCommand} runtime-host access issue --kind capability-provider --principal <id>`,
    `  ${cliCommand} runtime-host access revoke --credential <id>`,
    `  ${cliCommand} runtime-host project list [--root <path>]`,
    `  ${cliCommand} runtime-host project add <path> [--root <path>]`,
    `  ${cliCommand} runtime-host profile list`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --tls-url <wss-url> --expected-root <root-id> [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --ssh-destination <user@host> --ssh-remote-port <port> --expected-root <root-id> [--ssh-port <port>] [--credential-env <name>]`,
    `  ${cliCommand} runtime-host profile set --id <id> --name <name> --plaintext-url <ws-url> --acknowledge-plaintext --expected-root <root-id> [--credential-env <name>]`,
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
    'Runtime Host service options:',
    '  --root <path>                 Select the canonical data root',
    '  --websocket-port <port>       Enable an authenticated WebSocket listener',
    '  --websocket-host <host>       Bind host (default: 127.0.0.1)',
    '  --websocket-path <path>       Upgrade path (default: /runtime-host)',
    '  --tls-certificate <path>      TLS certificate for WSS',
    '  --tls-private-key <path>      TLS private key for WSS',
    '  --allow-insecure-remote       Allow plaintext WebSocket access beyond loopback',
    '  --allow-origin <origin>       Allow one browser Origin (repeatable)',
    '  --json                        Emit one machine-readable ready event',
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

export function formatResumeHint(
  sessionId: string | null,
  cliCommand: string = RELEASE_MAKA_CLI_LAUNCH_OPTIONS.cliCommand,
): string | null {
  return formatMakaResumeHint(cliCommand, sessionId);
}

export async function runMakaCli(
  argv: string[] = process.argv.slice(2),
  options: MakaCliLaunchOptions = RELEASE_MAKA_CLI_LAUNCH_OPTIONS,
): Promise<number> {
  const version = await readPackageVersion();
  const command = parseMakaCliArgs(argv, version, options.cliCommand);
  const dataRoots = resolveMakaDataRoots({ profileName: options.dataProfileName });
  switch (command.kind) {
    case 'run': {
      const { runRuntimeHostTextCli } = await import('./runtime-host-run-command.js');
      return runRuntimeHostTextCli(
        command.args,
        { workspaceRoot: () => dataRoots.workspaceRoot },
        {},
        { clientDataRoot: dataRoots.clientDataRoot, cliCommand: options.cliCommand },
      );
    }
    case 'activate': {
      const { runMakaActivationCli } = await import('./activation-command.js');
      return runMakaActivationCli(command.args);
    }
    case 'eval': {
      const { runMakaEvalCli } = await import('@maka/eval');
      return runMakaEvalCli(command.args);
    }
    case 'runtime-host-serve': {
      const { runRuntimeHostServiceCli } = await import('./runtime-host-service-command.js');
      return runRuntimeHostServiceCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        json: command.json,
        ...(command.websocket ? { websocket: command.websocket } : {}),
      });
    }
    case 'runtime-host-access-issue': {
      const { runRuntimeHostAccessIssueCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessIssueCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        principalKind: command.principalKind,
        principalId: command.principalId,
        operationGrants: command.operationGrants,
        canPublishClientCapabilities: command.canPublishClientCapabilities,
        canUseHostPaths: command.canUseHostPaths,
        ...(command.preset ? { preset: command.preset } : {}),
      });
    }
    case 'runtime-host-access-revoke': {
      const { runRuntimeHostAccessRevokeCli } = await import('./runtime-host-access-command.js');
      return runRuntimeHostAccessRevokeCli({
        rootPath: command.rootPath ?? dataRoots.workspaceRoot,
        credentialId: command.credentialId,
      });
    }
    case 'runtime-host-project-list':
    case 'runtime-host-project-add': {
      const { runRuntimeHostProjectCli } = await import('./runtime-host-project-command.js');
      const rootPath = command.rootPath ?? dataRoots.workspaceRoot;
      return command.kind === 'runtime-host-project-list'
        ? runRuntimeHostProjectCli({ kind: 'list', rootPath })
        : runRuntimeHostProjectCli({ kind: 'add', rootPath, path: command.path });
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
    case 'runtime-host-profile-remove': {
      const { runRuntimeHostProfileCommand } = await import('./runtime-host-profile-command.js');
      const profileOptions = { clientDataRoot: dataRoots.clientDataRoot };
      if (command.kind === 'runtime-host-profile-list') {
        return runRuntimeHostProfileCommand({ kind: 'list' }, {}, profileOptions);
      }
      if (command.kind === 'runtime-host-profile-remove') {
        return runRuntimeHostProfileCommand({ kind: 'remove', id: command.id }, {}, profileOptions);
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
      process.stderr.write(`${command.message}\n\n${helpText(options.cliCommand)}\n`);
      return command.exitCode;
    case 'tui': {
      const { runRuntimeHostTui } = await import('./runtime-host-tui-command.js');
      return runRuntimeHostTui({
        cliCommand: options.cliCommand,
        clientDataRoot: dataRoots.clientDataRoot,
        workspaceRoot: dataRoots.workspaceRoot,
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
      return { kind: 'error', message: `Unexpected argument: ${option ?? ''}`, exitCode: 2 };
    }
    if (values.has(option)) {
      return { kind: 'error', message: `Option repeated: ${option}`, exitCode: 2 };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      const expected =
        option === '--resume' ? 'a session id' : option === '--cwd' ? 'a directory' : 'a value';
      return { kind: 'error', message: `${option} requires ${expected}`, exitCode: 2 };
    }
    values.set(option, value);
    index += 1;
  }
  if (values.has('--cwd') && !values.has('--resume')) {
    return { kind: 'error', message: '--cwd requires --resume', exitCode: 2 };
  }
  if (values.has('--project') && values.has('--resume')) {
    return { kind: 'error', message: '--project cannot be used with --resume', exitCode: 2 };
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

if (isMainModule()) launchMakaCli(RELEASE_MAKA_CLI_LAUNCH_OPTIONS);

// ShellRun escalates SIGTERM to SIGKILL after two seconds. Keep the CLI alive
// long enough for that cleanup to finish before the final process fallback.
const PROCESS_EXIT_GRACE_MS = 3_000;

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

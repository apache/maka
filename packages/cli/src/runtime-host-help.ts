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

const SUBCOMMANDS = {
  activate: {
    summary: 'Run one framed activation against a managed root',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host activate --framed --root-id <id>`,
      `  ${cliCommand} runtime-host connect --framed --root-id <id>`,
      '',
      'Managed root options:',
      '  --framed                      Frame stdio for a supervising parent',
      '  --root-id <id>                Pin the canonical Runtime Host root identity',
      '  --repair-root-after-remount   Repair the root after its volume was remounted',
    ],
  },
  serve: {
    summary: 'Run a Runtime Host service',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host serve [options]  Run a Runtime Host service`,
      '',
      'Options:',
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
    ],
  },
  setup: {
    summary: 'Provision a managed Runtime Host',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host setup --principal <id> --preset <desktop-client|terminal-client> [options]`,
      '',
      'Options (Linux or macOS):',
      '  --principal <id>              Stable Client pairing identity',
      '  --preset <name>               Pair a desktop-client or terminal-client',
      '  --root <path>                 Select the canonical data root',
      '  --project-root <label>=<path> Publish an absolute directory root (repeatable)',
      '  --no-project-roots            Disable remote project browsing and registration',
      '  --websocket-port <port>       Persist a loopback port (chosen automatically by default)',
      '  --websocket-path <path>       Persist the upgrade path (default: /runtime-host)',
      '  --json                        Emit framed machine-readable progress and result records',
      '',
    ],
  },
  service: {
    summary: 'Install and operate the managed service',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host service install [options]`,
      `  ${cliCommand} runtime-host service configure (--project-root <label>=<path> ... | --no-project-roots) --expected-config-fingerprint <sha256:...> --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
      `  ${cliCommand} runtime-host service status|start|stop|restart|logs [--json]`,
      `  ${cliCommand} runtime-host service uninstall --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
      `  ${cliCommand} runtime-host service peer enable|disable|status|rotate|descriptor [options]`,
      `  ${cliCommand} runtime-host service mesh status|create|invite|join|remove|leave|close|reconcile [options]`,
      `  ${cliCommand} runtime-host service retire --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
      `  ${cliCommand} runtime-host service check-update --target <latest|next|version> [--json]`,
      `  ${cliCommand} runtime-host service update [--target <latest|next|version>] --expected-service-id <id> --expected-root-path <path> --expected-root-id <id> [--allow-interrupt-active-tasks]`,
      `  ${cliCommand} runtime-host service update-policy [--target <manual|latest|next|version>] [--json]`,
      `  ${cliCommand} runtime-host service reconcile-update [--json]`,
      '',
      'Install options (Linux or macOS):',
      '  --root <path>                 Select the canonical data root',
      '  --project-root <label>=<path> Publish an absolute directory root (repeatable)',
      '  --no-project-roots            Disable remote project browsing and registration',
      '  --websocket-port <port>       Persist a loopback port (chosen automatically by default)',
      '  --websocket-path <path>       Persist the upgrade path (default: /runtime-host)',
      '  --json                        Emit a machine-readable result',
      '',
      '',
      'Direct-peer options:',
      '  --listen <multiaddr>          Persist a listener address (repeatable)',
      '  --coordination-relay <addr>   Prefer a Circuit Relay v2 address (repeatable)',
      '  --clear-coordination-relays   Remove every manually configured relay',
      '  --automatic-relay-discovery   Enable best-effort public relay discovery',
      '  --no-automatic-relay-discovery  Disable public discovery and retain manual relays',
      '  --default-public-stun          Use the packaged best-effort public STUN policy',
      '  --no-public-stun               Disable public STUN and keep host candidates only',
      '  --webrtc-stun <stun-url>       Use a custom STUN endpoint (repeatable)',
      '',
    ],
  },
  access: {
    summary: 'Issue and revoke access credentials',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host access issue --principal <id> --grant <operation>`,
      `  ${cliCommand} runtime-host access issue --principal <id> --preset <desktop-client|terminal-client>`,
      `  ${cliCommand} runtime-host access connection-code [--name <name>] [--root <path>]`,
      `  ${cliCommand} runtime-host access list`,
      `  ${cliCommand} runtime-host access issue --kind capability-provider --principal <id>`,
      `  ${cliCommand} runtime-host access revoke --credential <id>`,
      '',
      'Issue options:',
      '  --root <path>                 Select the canonical data root',
      '  --kind <kind>                 remote-owner or capability-provider',
      '  --principal <id>              Name the authenticated Client principal',
      '  --grant <operation>           Grant one exact operation (repeatable)',
      '  --preset <name>               Grant the desktop-client or terminal-client operation set',
      '  --publish-client-capabilities Allow Client Capability publication',
      '  --allow-host-paths            Allow operations that submit Host paths',
      '  --capability-owner-credential <id>  Bind a provider to one Client-bound owner credential',
      '',
    ],
  },
  project: {
    summary: 'Register project directory roots',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host project list [--root <path>]`,
      `  ${cliCommand} runtime-host project add <path> [--prefer] [--root <path>]`,
    ],
  },
  plugin: {
    summary: 'Install and inspect plugins',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host plugin status|list|inspect|failures [--root <path>]`,
      `  ${cliCommand} runtime-host plugin install|uninstall|reload <target> [--root <path>]`,
      `  ${cliCommand} runtime-host plugin export <extension-id> <bundle-path> [--root <path>]`,
      `  ${cliCommand} runtime-host plugin apply <operations.json> [--root <path>]`,
      `  ${cliCommand} runtime-host plugin reconcile [--root <path>]`,
    ],
  },
  profile: {
    summary: 'Save and select remote Host profiles',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host profile list`,
      `  ${cliCommand} runtime-host profile set --id <id> --name <name> --tls-url <wss-url> --expected-root <root-id> [--credential-env <name>]`,
      `  ${cliCommand} runtime-host profile set --id <id> --name <name> --ssh-destination <user@host> --ssh-remote-port <port> --expected-root <root-id> [--ssh-port <port>] [--credential-env <name>]`,
      `  ${cliCommand} runtime-host profile set --id <id> --name <name> --plaintext-url <ws-url> --acknowledge-plaintext --expected-root <root-id> [--credential-env <name>]`,
      `  ${cliCommand} runtime-host profile remove --id <id>`,
      '',
      'Environment:',
      '  MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL  Access credential used when --credential-env is omitted',
    ],
  },
  'capability-provider': {
    summary: 'Publish MCP tools to a Host',
    lines: (cliCommand: string) => [
      `  ${cliCommand} runtime-host capability-provider serve --url <ws-url> --mcp-config <path> --expected-root <root-id>`,
      '',
      'Options:',
      '  --url <ws-url>                Connect to an authenticated Runtime Host WebSocket',
      '  --mcp-config <path>           Publish tools from an MCP configuration file',
      '  --expected-root <root-id>     Pin the canonical Runtime Host root identity',
      '  --credential-env <name>       Read the access credential from this environment variable',
      '  --client-identity <path>      Persist the provider Client instance identity here',
    ],
  },
} as const;

export type RuntimeHostHelpTopic = keyof typeof SUBCOMMANDS;

export function isRuntimeHostHelpTopic(value: string): value is RuntimeHostHelpTopic {
  return Object.hasOwn(SUBCOMMANDS, value);
}

/** Overview of the Runtime Host commands, one line each. */
export function runtimeHostHelpText(cliCommand: string): string {
  return [
    `Usage: ${cliCommand} runtime-host <command> [options]`,
    '',
    'Serves and manages a Runtime Host: the background service that runs Sessions.',
    '',
    'Commands:',
    ...Object.entries(SUBCOMMANDS).map(([name, topic]) => `  ${name.padEnd(20)}${topic.summary}`),
    '',
    `Run \`${cliCommand} runtime-host <command> --help\` for its own options.`,
  ].join('\n');
}

/** A lone command line that only repeats the Usage grammar adds nothing to its screen. */
function withoutRedundantUsage(lines: readonly string[], usage: string): readonly string[] {
  const rest = lines[0]?.trim().startsWith(usage) ? lines.slice(1) : lines;
  const body = rest[0]?.trim() === '' ? rest.slice(1) : rest;
  // A screen that still opens on command lines needs the heading its option
  // sections already carry.
  return body[0]?.startsWith('  ') && !body[0].trim().startsWith('-')
    ? ['Commands:', ...body]
    : body;
}

/** Every command line and option belonging to one Runtime Host command. */
export function runtimeHostCommandHelpText(
  cliCommand: string,
  topic: RuntimeHostHelpTopic,
): string {
  return [
    `Usage: ${cliCommand} runtime-host ${topic} [options]`,
    '',
    ...withoutRedundantUsage(
      SUBCOMMANDS[topic].lines(cliCommand),
      `${cliCommand} runtime-host ${topic} [options]`,
    ),
  ].join('\n');
}

/** `maka update` manages the npm-global CLI, so it sits outside the Host topics. */
export function installedUpdateHelpText(cliCommand: string): string {
  return [
    `Usage: ${cliCommand} update [options]`,
    '',
    'Updates this npm-global CLI and the Runtime Host it manages locally.',
    '',
    'Options:',
    '  --target <latest|next|version>  Select the release to install',
    '  --allow-interrupt-active-tasks  Update even while the Host has running work',
  ].join('\n');
}

/** Session bundles move a Session between workspaces; neither side takes flags beyond these. */
export function sessionBundleHelpText(
  cliCommand: string,
  command: 'session-export' | 'session-import',
): string {
  return command === 'session-export'
    ? [
        `Usage: ${cliCommand} session-export --workspace-root <dir> --session <id> --out <file.maka-session>`,
        '',
        'Writes one Session and its transcript to a portable bundle.',
        '',
        'Options:',
        '  --workspace-root <dir>   Workspace holding the Session',
        '  --session <id>           Session to export',
        '  --out <file>             Bundle path to write',
      ].join('\n')
    : [
        `Usage: ${cliCommand} session-import --workspace-root <dir> --bundle <file.maka-session>`,
        '',
        'Reads a Session bundle back into a workspace.',
        '',
        'Options:',
        '  --workspace-root <dir>   Workspace to import into',
        '  --bundle <file>          Bundle path to read',
      ].join('\n');
}

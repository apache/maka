type RuntimeHostCliError = { kind: 'error'; message: string; exitCode: number };

export type RuntimeHostCliCommand =
  | {
      kind: 'runtime-host-serve';
      rootPath?: string;
      websocket?: {
        host: string;
        port: number;
        path?: string;
        tlsCertificatePath?: string;
        tlsPrivateKeyPath?: string;
        allowedOrigins?: string[];
      };
    }
  | {
      kind: 'runtime-host-access-issue';
      rootPath?: string;
      principalId: string;
      operationGrants: string[];
      canPublishClientCapabilities: boolean;
      canUseHostPaths: boolean;
    }
  | { kind: 'runtime-host-access-revoke'; rootPath?: string; credentialId: string }
  | RuntimeHostCliError;

export function parseRuntimeHostCommand(argv: string[]): RuntimeHostCliCommand {
  if (argv[0] === 'serve') return parseServeCommand(argv.slice(1));
  if (argv[0] === 'access') return parseAccessCommand(argv.slice(1));
  return error(
    argv[0]
      ? `Unexpected runtime-host command: ${argv[0]}`
      : 'runtime-host requires the serve or access command',
  );
}

function parseServeCommand(argv: string[]): RuntimeHostCliCommand {
  let rootPath: string | undefined;
  let websocketHost = '127.0.0.1';
  let websocketConfigured = false;
  let websocketPort: number | undefined;
  let websocketPath: string | undefined;
  let tlsCertificatePath: string | undefined;
  let tlsPrivateKeyPath: string | undefined;
  const allowedOrigins: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      rootPath = parsed;
      index += 1;
      continue;
    }
    if (argument === '--websocket-host') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketHost = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--websocket-port') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketPort = Number(parsed);
      websocketConfigured = true;
      if (!Number.isInteger(websocketPort) || websocketPort < 1 || websocketPort > 65_535) {
        return error('--websocket-port must be an integer between 1 and 65535');
      }
      index += 1;
      continue;
    }
    if (argument === '--websocket-path') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      websocketPath = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--tls-certificate' || argument === '--tls-private-key') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--tls-certificate') tlsCertificatePath = parsed;
      else tlsPrivateKeyPath = parsed;
      websocketConfigured = true;
      index += 1;
      continue;
    }
    if (argument === '--allow-origin') {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      allowedOrigins.push(parsed);
      websocketConfigured = true;
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if ((tlsCertificatePath === undefined) !== (tlsPrivateKeyPath === undefined)) {
    return error('--tls-certificate and --tls-private-key must be provided together');
  }
  if (websocketConfigured && websocketPort === undefined) {
    return error('--websocket-port is required for WebSocket options');
  }
  return {
    kind: 'runtime-host-serve',
    ...(rootPath ? { rootPath } : {}),
    ...(websocketPort === undefined
      ? {}
      : {
          websocket: {
            host: websocketHost,
            port: websocketPort,
            ...(websocketPath ? { path: websocketPath } : {}),
            ...(tlsCertificatePath ? { tlsCertificatePath } : {}),
            ...(tlsPrivateKeyPath ? { tlsPrivateKeyPath } : {}),
            ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
          },
        }),
  };
}

function parseAccessCommand(argv: string[]): RuntimeHostCliCommand {
  const action = argv[0];
  if (action !== 'issue' && action !== 'revoke') {
    return error(
      action
        ? `Unexpected runtime-host access command: ${action}`
        : 'runtime-host access requires the issue or revoke command',
    );
  }
  let rootPath: string | undefined;
  let principalId: string | undefined;
  let credentialId: string | undefined;
  const operationGrants: string[] = [];
  let canPublishClientCapabilities = false;
  let canUseHostPaths = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--publish-client-capabilities') {
      canPublishClientCapabilities = true;
      continue;
    }
    if (argument === '--allow-host-paths') {
      canUseHostPaths = true;
      continue;
    }
    if (
      argument === '--root' ||
      argument === '--principal' ||
      argument === '--grant' ||
      argument === '--credential'
    ) {
      const parsed = optionValue(argv, index, argument);
      if (typeof parsed !== 'string') return parsed;
      if (argument === '--root') rootPath = parsed;
      if (argument === '--principal') principalId = parsed;
      if (argument === '--grant') operationGrants.push(parsed);
      if (argument === '--credential') credentialId = parsed;
      index += 1;
      continue;
    }
    return error(`Unexpected argument: ${argument ?? ''}`);
  }
  if (action === 'issue') {
    if (!principalId) return error('--principal is required');
    if (operationGrants.length === 0) return error('At least one --grant is required');
    if (credentialId) return error('--credential is only valid for access revoke');
    return {
      kind: 'runtime-host-access-issue',
      ...(rootPath ? { rootPath } : {}),
      principalId,
      operationGrants,
      canPublishClientCapabilities,
      canUseHostPaths,
    };
  }
  if (!credentialId) return error('--credential is required');
  if (
    principalId ||
    operationGrants.length > 0 ||
    canPublishClientCapabilities ||
    canUseHostPaths
  ) {
    return error('Issue-only access options are not valid for revoke');
  }
  return {
    kind: 'runtime-host-access-revoke',
    ...(rootPath ? { rootPath } : {}),
    credentialId,
  };
}

function optionValue(argv: string[], index: number, option: string): string | RuntimeHostCliError {
  const value = argv[index + 1];
  return !value || value.startsWith('-') ? error(`${option} requires a value`) : value;
}

function error(message: string): RuntimeHostCliError {
  return { kind: 'error', message, exitCode: 2 };
}

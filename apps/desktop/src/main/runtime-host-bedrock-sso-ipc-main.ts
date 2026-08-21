import { randomUUID } from 'node:crypto';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import type { ReconnectableReadIpcMain } from './ipc-reconnect-policy.js';
import type { RuntimeHostOAuthPresentation } from './runtime-host-oauth-presentation.js';

export const BEDROCK_SSO_IPC_CHANNELS = [
  'amazon-bedrock-sso:get-state',
  'amazon-bedrock-sso:start',
  'amazon-bedrock-sso:query',
  'amazon-bedrock-sso:cancel',
  'amazon-bedrock-sso:list-accounts',
  'amazon-bedrock-sso:list-roles',
  'amazon-bedrock-sso:fetch-models',
  'amazon-bedrock-sso:commit',
] as const;

export function registerRuntimeHostBedrockSsoIpc(input: {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly presentation: RuntimeHostOAuthPresentation;
  readonly emitConnectionListChanged: () => void;
}): void {
  input.ipcMain.handle('amazon-bedrock-sso:get-state', async () => {
    const catalog = await input.client.loadConnectionCatalog();
    const connection = catalog.connections.find((candidate) => candidate.providerType === 'amazon-bedrock');
    if (!connection) return { runtimeState: 'not_logged_in' as const };
    const credential = await input.client.queryCredential({
      scope: 'connection',
      connectionId: connection.connectionId,
      kind: 'aws_sso',
    });
    return credential?.configured
      ? {
          runtimeState: 'authenticated' as const,
          accountId: connection.bedrock?.accountId,
          roleName: connection.bedrock?.roleName,
          region: connection.bedrock?.region,
        }
      : { runtimeState: 'not_logged_in' as const };
  });
  input.ipcMain.handle('amazon-bedrock-sso:start', async (_event, configuration: unknown) => {
    if (!isStartConfiguration(configuration)) throw new Error('Invalid Amazon Bedrock SSO configuration');
    const attemptId = randomUUID();
    const expectation = input.presentation.expect(attemptId);
    try {
      const projection = await input.client.startBedrockSsoLogin({ attemptId, ...configuration });
      await expectation.presented;
      return projection;
    } catch (error) {
      expectation.cancel(error);
      await input.client.cancelBedrockSsoLogin(attemptId).catch(() => undefined);
      throw error;
    }
  });
  input.ipcMain.handle('amazon-bedrock-sso:query', (_event, attemptId: unknown) =>
    input.client.queryBedrockSsoLogin(requireString(attemptId)),
  );
  input.ipcMain.handle('amazon-bedrock-sso:cancel', (_event, attemptId: unknown) => {
    const id = requireString(attemptId);
    input.presentation.cancel(id);
    return input.client.cancelBedrockSsoLogin(id);
  });
  input.ipcMain.handle('amazon-bedrock-sso:list-accounts', (_event, attemptId: unknown) =>
    input.client.listBedrockSsoAccounts(requireString(attemptId)),
  );
  input.ipcMain.handle(
    'amazon-bedrock-sso:list-roles',
    (_event, attemptId: unknown, accountId: unknown) =>
      input.client.listBedrockSsoRoles(requireString(attemptId), requireString(accountId)),
  );
  input.ipcMain.handle(
    'amazon-bedrock-sso:fetch-models',
    (
      _event,
      attemptId: unknown,
      accountId: unknown,
      roleName: unknown,
      manualModelIds: unknown,
    ) =>
      input.client.fetchBedrockSsoModels({
        attemptId: requireString(attemptId),
        accountId: requireString(accountId),
        roleName: requireString(roleName),
        manualModelIds: requireStrings(manualModelIds),
      }),
  );
  input.ipcMain.handle(
    'amazon-bedrock-sso:commit',
    async (_event, attemptId: unknown, enabledModelIds: unknown) => {
      const result = await input.client.commitBedrockSsoOnboarding({
        attemptId: requireString(attemptId),
        enabledModelIds: requireStrings(enabledModelIds),
      });
      input.emitConnectionListChanged();
      return result;
    },
  );
}

function isStartConfiguration(value: unknown): value is {
  ssoStartUrl: string;
  ssoRegion: string;
  region: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.ssoStartUrl === 'string' &&
    typeof record.ssoRegion === 'string' &&
    typeof record.region === 'string'
  );
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid Bedrock SSO input');
  return value;
}

function requireStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Invalid Bedrock SSO list input');
  }
  return value;
}

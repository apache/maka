import {
  AuthorizationPendingException,
  CreateTokenCommand,
  RegisterClientCommand,
  SlowDownException,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from '@aws-sdk/client-sso-oidc';
import {
  GetRoleCredentialsCommand,
  ListAccountRolesCommand,
  ListAccountsCommand,
  SSOClient,
} from '@aws-sdk/client-sso';
import type { AwsCredentialIdentity } from './model-factory.js';
import { ScopedFetchHttpHandler } from './aws-smithy-fetch-handler.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_TOKEN_CHARS = 32 * 1024;
const MAX_LIST_ITEMS = 1_024;
const MAX_PAGES = 64;

export interface BedrockSsoSession {
  readonly version: 1;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretExpiresAt: number;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken: string;
  readonly scope: readonly string[];
}

export interface BedrockSsoDeviceAuthorization {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretExpiresAt: number;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
}

export interface BedrockSsoAccount {
  readonly accountId: string;
  readonly accountName?: string;
  readonly emailAddress?: string;
}

export function serializeBedrockSsoSession(session: BedrockSsoSession): string {
  return JSON.stringify(session);
}

export function parseBedrockSsoSession(raw: string): BedrockSsoSession | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
      return null;
    }
    const expectedKeys = [
      'version',
      'clientId',
      'clientSecret',
      'clientSecretExpiresAt',
      'accessToken',
      'expiresAt',
      'refreshToken',
      'scope',
    ];
    if (
      Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(value, key))
    ) {
      return null;
    }
    const clientId = bounded(value.clientId);
    const clientSecret = bounded(value.clientSecret);
    const accessToken = bounded(value.accessToken);
    const refreshToken = bounded(value.refreshToken);
    const clientSecretExpiresAt = timestamp(value.clientSecretExpiresAt);
    const expiresAt = timestamp(value.expiresAt);
    if (
      !clientId ||
      !clientSecret ||
      !accessToken ||
      !refreshToken ||
      !Number.isSafeInteger(clientSecretExpiresAt) ||
      !Number.isSafeInteger(expiresAt)
    ) {
      return null;
    }
    if (
      !Array.isArray(value.scope) ||
      value.scope.length === 0 ||
      value.scope.length > 16 ||
      value.scope.some(
        (entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > 256,
      ) ||
      new Set(value.scope).size !== value.scope.length
    ) {
      return null;
    }
    return {
      version: 1,
      clientId,
      clientSecret,
      clientSecretExpiresAt,
      accessToken,
      expiresAt,
      refreshToken,
      scope: value.scope as string[],
    };
  } catch {
    return null;
  }
}

export async function startBedrockSsoDeviceAuthorization(input: {
  readonly ssoStartUrl: string;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<BedrockSsoDeviceAuthorization> {
  const client = oidcClient(input.ssoRegion, input.fetchFn);
  const registration = await client.send(
    new RegisterClientCommand({
      clientName: 'maka',
      clientType: 'public',
      scopes: ['sso:account:access'],
      grantTypes: [DEVICE_GRANT, 'refresh_token'],
    }),
    { abortSignal: input.signal },
  );
  const clientId = required(registration.clientId, 'IAM Identity Center client id');
  const clientSecret = required(registration.clientSecret, 'IAM Identity Center client secret');
  const clientSecretExpiresAt = secondsTimestamp(
    registration.clientSecretExpiresAt,
    'IAM Identity Center client registration expiration',
  );
  const authorization = await client.send(
    new StartDeviceAuthorizationCommand({
      clientId,
      clientSecret,
      startUrl: input.ssoStartUrl,
    }),
    { abortSignal: input.signal },
  );
  const now = input.now ?? Date.now;
  const verificationUri = trustedAwsPresentationUrl(
    required(authorization.verificationUri, 'SSO verification URI'),
  );
  const verificationUriComplete = trustedAwsPresentationUrl(
    authorization.verificationUriComplete ?? verificationUri,
  );
  return {
    clientId,
    clientSecret,
    clientSecretExpiresAt,
    deviceCode: required(authorization.deviceCode, 'SSO device code'),
    userCode: required(authorization.userCode, 'SSO user code', 1_024),
    verificationUri,
    verificationUriComplete,
    expiresAt: now() + positive(authorization.expiresIn, 'SSO device expiration') * 1_000,
    intervalSeconds: authorization.interval ?? 5,
  };
}

export async function pollBedrockSsoDeviceAuthorization(input: {
  readonly authorization: BedrockSsoDeviceAuthorization;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<BedrockSsoSession> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? abortableSleep;
  const client = oidcClient(input.ssoRegion, input.fetchFn);
  let intervalMs = Math.max(1_000, input.authorization.intervalSeconds * 1_000);
  while (now() < input.authorization.expiresAt) {
    input.signal?.throwIfAborted();
    try {
      const token = await client.send(
        new CreateTokenCommand({
          clientId: input.authorization.clientId,
          clientSecret: input.authorization.clientSecret,
          grantType: DEVICE_GRANT,
          deviceCode: input.authorization.deviceCode,
        }),
        { abortSignal: input.signal },
      );
      return tokenSession(token, input.authorization, now());
    } catch (error) {
      if (error instanceof AuthorizationPendingException) {
        await sleep(intervalMs, input.signal);
        continue;
      }
      if (error instanceof SlowDownException) {
        intervalMs += 5_000;
        await sleep(intervalMs, input.signal);
        continue;
      }
      throw error;
    }
  }
  throw new Error('IAM Identity Center device authorization expired');
}

export async function refreshBedrockSsoSession(input: {
  readonly session: BedrockSsoSession;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<BedrockSsoSession> {
  const now = input.now ?? Date.now;
  if (input.session.clientSecretExpiresAt <= now()) {
    throw new Error('IAM Identity Center client registration expired');
  }
  const token = await oidcClient(input.ssoRegion, input.fetchFn).send(
    new CreateTokenCommand({
      clientId: input.session.clientId,
      clientSecret: input.session.clientSecret,
      grantType: 'refresh_token',
      refreshToken: input.session.refreshToken,
    }),
    { abortSignal: input.signal },
  );
  return {
    ...input.session,
    accessToken: required(token.accessToken, 'SSO access token'),
    expiresAt: now() + positive(token.expiresIn, 'SSO token expiration') * 1_000,
    refreshToken: token.refreshToken ?? input.session.refreshToken,
  };
}

export async function listBedrockSsoAccounts(input: {
  readonly accessToken: string;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<readonly BedrockSsoAccount[]> {
  const client = ssoClient(input.ssoRegion, input.fetchFn);
  const result: BedrockSsoAccount[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.send(
      new ListAccountsCommand({ accessToken: input.accessToken, maxResults: 100, nextToken }),
      { abortSignal: input.signal },
    );
    for (const account of response.accountList ?? []) {
      if (!account.accountId || result.some((entry) => entry.accountId === account.accountId))
        continue;
      result.push({
        accountId: account.accountId,
        ...(account.accountName ? { accountName: account.accountName } : {}),
        ...(account.emailAddress ? { emailAddress: account.emailAddress } : {}),
      });
      if (result.length > MAX_LIST_ITEMS)
        throw new Error('IAM Identity Center account limit exceeded');
    }
    nextToken = response.nextToken;
    if (!nextToken) return result;
  }
  throw new Error('IAM Identity Center account pagination limit exceeded');
}

export async function listBedrockSsoRoles(input: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<readonly string[]> {
  const client = ssoClient(input.ssoRegion, input.fetchFn);
  const roles: string[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.send(
      new ListAccountRolesCommand({
        accessToken: input.accessToken,
        accountId: input.accountId,
        maxResults: 100,
        nextToken,
      }),
      { abortSignal: input.signal },
    );
    for (const role of response.roleList ?? []) {
      if (role.roleName && !roles.includes(role.roleName)) roles.push(role.roleName);
      if (roles.length > MAX_LIST_ITEMS) throw new Error('IAM Identity Center role limit exceeded');
    }
    nextToken = response.nextToken;
    if (!nextToken) return roles;
  }
  throw new Error('IAM Identity Center role pagination limit exceeded');
}

export async function getBedrockSsoRoleCredentials(input: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly ssoRegion: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<AwsCredentialIdentity> {
  const response = await ssoClient(input.ssoRegion, input.fetchFn).send(
    new GetRoleCredentialsCommand({
      accessToken: input.accessToken,
      accountId: input.accountId,
      roleName: input.roleName,
    }),
    { abortSignal: input.signal },
  );
  const credentials = response.roleCredentials;
  if (!credentials) throw new Error('IAM Identity Center returned no role credentials');
  return {
    accessKeyId: required(credentials.accessKeyId, 'AWS role access key'),
    secretAccessKey: required(credentials.secretAccessKey, 'AWS role secret key'),
    sessionToken: required(credentials.sessionToken, 'AWS role session token'),
    expiration: new Date(positive(credentials.expiration, 'AWS role credential expiration')),
  };
}

function oidcClient(region: string, fetchFn: typeof fetch): SSOOIDCClient {
  return new SSOOIDCClient({ region, requestHandler: new ScopedFetchHttpHandler(fetchFn) });
}

function ssoClient(region: string, fetchFn: typeof fetch): SSOClient {
  return new SSOClient({ region, requestHandler: new ScopedFetchHttpHandler(fetchFn) });
}

function tokenSession(
  token: { accessToken?: string; refreshToken?: string; expiresIn?: number },
  authorization: BedrockSsoDeviceAuthorization,
  now: number,
): BedrockSsoSession {
  return {
    version: 1,
    clientId: authorization.clientId,
    clientSecret: authorization.clientSecret,
    clientSecretExpiresAt: authorization.clientSecretExpiresAt,
    accessToken: required(token.accessToken, 'SSO access token'),
    expiresAt: now + positive(token.expiresIn, 'SSO token expiration') * 1_000,
    refreshToken: required(token.refreshToken, 'SSO refresh token'),
    scope: ['sso:account:access'],
  };
}

function trustedAwsPresentationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('IAM Identity Center returned an invalid verification URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (!hostname.endsWith('.amazonaws.com') &&
      !hostname.endsWith('.amazonaws.com.cn') &&
      !hostname.endsWith('.awsapps.com'))
  ) {
    throw new Error('IAM Identity Center returned an untrusted verification URL');
  }
  return url.toString();
}

function required(value: unknown, label: string, maximum = MAX_TOKEN_CHARS): string {
  const string = bounded(value, maximum);
  if (!string) throw new Error(`${label} is missing`);
  return string;
}

function bounded(value: unknown, maximum = MAX_TOKEN_CHARS): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
}

function secondsTimestamp(value: unknown, label: string): number {
  return positive(value, label) * 1_000;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

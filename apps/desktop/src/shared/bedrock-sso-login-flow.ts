export interface BedrockSsoLoginProjection {
  readonly attemptId: string;
  readonly phase: 'awaiting_authorization' | 'authenticated' | 'failed' | 'cancelled';
  readonly userCode?: string;
}

export interface BedrockSsoLoginBridge<Host> {
  start(
    input: { ssoStartUrl: string; ssoRegion: string; region: string },
    host: Host,
  ): Promise<BedrockSsoLoginProjection>;
  query(attemptId: string, host: Host): Promise<BedrockSsoLoginProjection>;
  listAccounts(
    attemptId: string,
    host: Host,
  ): Promise<{
    accounts: readonly { accountId: string; accountName?: string; emailAddress?: string }[];
  }>;
  listRoles(
    attemptId: string,
    accountId: string,
    host: Host,
  ): Promise<{ roles: readonly string[] }>;
}

export interface BedrockSsoLoginResult {
  readonly attemptId: string;
  readonly accounts: readonly {
    accountId: string;
    accountName?: string;
    emailAddress?: string;
  }[];
  readonly accountId: string;
  readonly roles: readonly string[];
  readonly roleName: string;
}

/** Drives renderer-safe login through the first account and role selection. */
export async function runBedrockSsoLogin<Host>(input: {
  readonly bridge: BedrockSsoLoginBridge<Host>;
  readonly host: Host;
  readonly ssoStartUrl: string;
  readonly ssoRegion: string;
  readonly region: string;
  readonly isActive: () => boolean;
  readonly wait?: () => Promise<void>;
  readonly onProjection?: (projection: BedrockSsoLoginProjection) => void;
}): Promise<BedrockSsoLoginResult | null> {
  const started = await input.bridge.start(
    {
      ssoStartUrl: input.ssoStartUrl,
      ssoRegion: input.ssoRegion,
      region: input.region,
    },
    input.host,
  );
  input.onProjection?.(started);
  let current = started;
  while (input.isActive() && current.phase === 'awaiting_authorization') {
    await (input.wait?.() ?? Promise.resolve());
    current = await input.bridge.query(started.attemptId, input.host);
    input.onProjection?.(current);
  }
  if (!input.isActive()) return null;
  if (current.phase !== 'authenticated') throw new Error('AWS SSO sign-in did not complete.');

  const listed = await input.bridge.listAccounts(started.attemptId, input.host);
  if (!input.isActive()) return null;
  const firstAccount = listed.accounts[0];
  if (!firstAccount) {
    throw new Error('This IAM Identity Center user has no assigned AWS accounts.');
  }
  const roleResult = await input.bridge.listRoles(
    started.attemptId,
    firstAccount.accountId,
    input.host,
  );
  if (!input.isActive()) return null;
  const firstRole = roleResult.roles[0];
  if (!firstRole) throw new Error('The selected AWS account has no assigned roles.');
  return {
    attemptId: started.attemptId,
    accounts: listed.accounts,
    accountId: firstAccount.accountId,
    roles: roleResult.roles,
    roleName: firstRole,
  };
}

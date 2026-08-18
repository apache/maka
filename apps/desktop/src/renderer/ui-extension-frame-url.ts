export function uiExtensionFrameUrl(input: {
  readonly scopeId: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly contributionId: string;
  readonly token: string;
}): string {
  const url = new URL('maka-ui://frame/v1');
  url.searchParams.set('scopeId', input.scopeId);
  url.searchParams.set('entryId', input.entryId);
  url.searchParams.set('extensionId', input.extensionId);
  url.searchParams.set('revision', input.revision);
  url.searchParams.set('contributionId', input.contributionId);
  url.searchParams.set('token', input.token);
  return url.toString();
}

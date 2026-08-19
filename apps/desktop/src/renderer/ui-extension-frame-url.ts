export function uiExtensionFrameUrl(input: {
  readonly scopeId: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly contributionId: string;
  readonly token: string;
}): string {
  const url = new URL('maka-ui://frame/v1');
  url.searchParams.set('scopeId', input.scopeId);
  url.searchParams.set('entryId', input.entryId);
  url.searchParams.set('extensionId', input.extensionId);
  url.searchParams.set('generation', String(input.generation));
  url.searchParams.set('contributionId', input.contributionId);
  url.searchParams.set('token', input.token);
  return url.toString();
}

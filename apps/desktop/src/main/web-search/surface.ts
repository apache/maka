import { validateWorkspacePrivacyContext } from '@maka/core';
import type { MakaTool } from '@maka/runtime';
import type { SettingsStore } from '@maka/storage';
import { resolveTavilyApiKey } from './credentials.js';

const WEB_SEARCH_TOOL_NAME = 'WebSearch';

export function webSearchToolsForAvailability(
  tools: readonly MakaTool[],
  available: boolean,
): MakaTool[] {
  if (available) return [...tools];
  return tools.filter((tool) => tool.name !== WEB_SEARCH_TOOL_NAME);
}

export async function resolveDesktopWebSearchAvailability(deps: {
  settingsStore: Pick<SettingsStore, 'get'>;
  getPrivacyContext: () => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const privacy = validateWorkspacePrivacyContext(await deps.getPrivacyContext());
  if (!privacy.ok || privacy.value.incognitoActive) return false;

  const settings = await deps.settingsStore.get();
  return (
    settings.webSearch.enabled &&
    resolveTavilyApiKey({ settings, ...(deps.env ? { env: deps.env } : {}) }).length > 0
  );
}

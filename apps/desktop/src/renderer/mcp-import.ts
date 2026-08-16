import type { UiLocale } from '@maka/core/ui-locale';
import type { McpConfigFile, McpServerConfig } from '@maka/core/mcp';
import { getMcpCopy } from './locales/mcp-copy.js';

export function parseMcpImport(source: string, locale: UiLocale = 'zh'): McpConfigFile {
  const copy = getMcpCopy(locale);
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error(copy.errors.importObject);

  if ('mcpServers' in value || 'version' in value) {
    if ('version' in value && value.version !== 1) {
      throw new Error(copy.errors.importVersion(String(value.version)));
    }
    if (!isRecord(value.mcpServers)) throw new Error(copy.errors.importServersObject);
    return { version: 1, mcpServers: value.mcpServers as Record<string, McpServerConfig> };
  }

  return { version: 1, mcpServers: value as Record<string, McpServerConfig> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

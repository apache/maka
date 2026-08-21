import type { UiLocale } from '@maka/core/ui-locale';
import type { McpConfigFile, McpServerConfig } from '@maka/core/mcp';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { getMcpCopy } from './locales/mcp-copy.js';

export function parseMcpImport(source: string, locale: UiLocale = 'zh'): McpConfigFile {
  const copy = getMcpCopy(locale);
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error(copy.errors.importObject);

  const wrapped =
    (Object.hasOwn(value, 'version') && !isRecord(value.version)) ||
    (Object.hasOwn(value, 'mcpServers') &&
      (!isRecord(value.mcpServers) || !isMcpServerConfigShape(value.mcpServers)));
  const sourceVersion = wrapped && Object.hasOwn(value, 'version') ? value.version : 1;
  let mcpServers: Record<string, unknown>;

  if (wrapped) {
    if (sourceVersion !== 1 && sourceVersion !== MCP_CONFIG_VERSION) {
      throw new Error(copy.errors.importVersion(String(value.version)));
    }
    if (!isRecord(value.mcpServers)) throw new Error(copy.errors.importServersObject);
    mcpServers = value.mcpServers;
  } else {
    mcpServers = value;
  }

  if (sourceVersion === 1 && hasOwnProtocol(mcpServers)) {
    throw new Error(copy.errors.importProtocolVersion);
  }

  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: mcpServers as Record<string, McpServerConfig>,
  };
}

function hasOwnProtocol(mcpServers: Record<string, unknown>): boolean {
  return Object.values(mcpServers).some(
    (server) => isRecord(server) && Object.hasOwn(server, 'protocol'),
  );
}

function isMcpServerConfigShape(value: Record<string, unknown>): boolean {
  return typeof value.command === 'string' || typeof value.url === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

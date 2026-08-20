import type {
  NetworkProxyCandidate,
  ProxyType,
} from '@maka/core/settings/network-settings';

export function parseSystemProxyRules(rules: string): NetworkProxyCandidate | undefined {
  for (const entry of rules.split(';')) {
    const match = /^([^\s]+)\s+(.+)$/u.exec(entry.trim());
    if (!match) continue;
    const type = systemProxyType(match[1] ?? '');
    if (!type) continue;
    const endpoint = parseEndpoint(match[2] ?? '', type);
    if (!endpoint) continue;
    return {
      source: 'system',
      proxy: {
        enabled: true,
        type,
        host: endpoint.host,
        port: endpoint.port,
        bypassList: [],
      },
      requiresAuthentication: false,
    };
  }
  return undefined;
}

function systemProxyType(value: string): ProxyType | undefined {
  switch (value.toUpperCase()) {
    case 'PROXY':
    case 'HTTP':
      return 'http';
    case 'HTTPS':
      return 'https';
    case 'SOCKS':
    case 'SOCKS4':
    case 'SOCKS5':
      return 'socks5';
    default:
      return undefined;
  }
}

function parseEndpoint(value: string, type: ProxyType): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(`${type}://${value.trim()}`);
  } catch {
    return undefined;
  }
  const port = url.port ? Number(url.port) : defaultProxyPort(type);
  if (!url.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { host: stripIpv6Brackets(url.hostname), port };
}

function defaultProxyPort(type: ProxyType): number {
  if (type === 'https') return 443;
  if (type === 'socks5') return 1080;
  return 80;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

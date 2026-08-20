import type { NetworkProxyCandidate, ProxyType } from '@maka/core/settings/network-settings';

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

export function detectEnvironmentProxy(
  environment: Readonly<Record<string, string | undefined>>,
): NetworkProxyCandidate | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const candidate = parseProxyUrl(environment[key], environment);
    if (candidate) return candidate;
  }
  return undefined;
}

function parseProxyUrl(
  value: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): NetworkProxyCandidate | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const type = proxyType(url.protocol);
  if (!type || !url.hostname) return undefined;
  const port = url.port ? Number(url.port) : defaultProxyPort(type);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const requiresAuthentication = Boolean(url.username || url.password);
  return {
    source: 'environment',
    proxy: {
      enabled: true,
      type,
      host: stripIpv6Brackets(url.hostname),
      port,
      bypassList: proxyBypassList(environment),
    },
    requiresAuthentication,
  };
}

function proxyType(protocol: string): ProxyType | undefined {
  if (protocol === 'http:') return 'http';
  if (protocol === 'https:') return 'https';
  if (protocol === 'socks:' || protocol === 'socks5:' || protocol === 'socks5h:') return 'socks5';
  return undefined;
}

function defaultProxyPort(type: ProxyType): number {
  if (type === 'https') return 443;
  if (type === 'socks5') return 1080;
  return 80;
}

function proxyBypassList(environment: Readonly<Record<string, string | undefined>>): string[] {
  const value = environment.NO_PROXY ?? environment.no_proxy ?? '';
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

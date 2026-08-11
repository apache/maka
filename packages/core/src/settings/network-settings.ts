export type ProxyType = 'http' | 'https' | 'socks5';

export const SENSITIVE_PLACEHOLDER = '••••••••' as const;
export type Sensitive = string | typeof SENSITIVE_PLACEHOLDER;

export function applySensitivePatch(
  prev: string | undefined,
  next: Sensitive | undefined,
): string | undefined {
  if (next === undefined || next === SENSITIVE_PLACEHOLDER) return prev;
  if (next === '') return undefined;
  return next;
}

export function maskSensitive(value: string | undefined): typeof SENSITIVE_PLACEHOLDER | undefined {
  return value && value.length > 0 ? SENSITIVE_PLACEHOLDER : undefined;
}

export interface ProxySettings {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: Sensitive;
  bypassList: string[];
}

export interface RuntimeNetworkSettings {
  proxy: ProxySettings;
  timeout: number;
  retryAttempts: number;
  userAgent?: string;
  preferIpv4: boolean;
}

export const PROXY_DEFAULTS: ProxySettings = {
  enabled: false,
  type: 'http',
  host: '',
  port: 8080,
  bypassList: ['localhost', '127.0.0.1', '::1', '*.local'],
};

export const NETWORK_DEFAULTS: RuntimeNetworkSettings = {
  proxy: PROXY_DEFAULTS,
  timeout: 30_000,
  retryAttempts: 3,
  preferIpv4: false,
};

export interface TestProxyInput {
  proxy?: ProxySettings;
  url?: string;
  timeoutMs?: number;
}

export interface TestProxyResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  ip?: string;
  countryCode?: string;
  countryFlag?: string;
  error?: string;
}

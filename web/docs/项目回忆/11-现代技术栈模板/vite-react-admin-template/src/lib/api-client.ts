import { z } from 'zod';
import { camel2Under, under2Camel } from '@/lib/fetch-transform';
import { checkApiPermission } from '@/helpers/permission';
import { BUSINESS_ERROR_MSG, ERROR_CODE, ERROR_MSG } from '@/constants';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';
const TOKEN_KEY = 'token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 登录失效时的统一出口（默认回首页，接入 SSO/登录页后替换） */
let unauthorizedHandler: () => void = () => {
  window.location.href = '/';
};

export function setUnauthorizedHandler(handler: () => void) {
  unauthorizedHandler = handler;
}

interface RequestOptions<T> {
  /** 接口路径，如 /admin/user-info */
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** GET 查询参数（camelCase，发出前转 snake_case） */
  params?: object;
  /** 请求体（camelCase，发出前转 snake_case） */
  data?: unknown;
  /** Zod Schema：对响应 info 做运行时校验，契约在前 */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

/**
 * 基础请求函数
 *
 * 职责链：API 权限前置校验 → 命名转换 → 统一错误码 → Zod 校验。
 * 后端响应约定 { code: '0', msg, info }；若后端返回原始 payload，
 * 只需删掉 code/msg/info 的解包逻辑这一处。
 */
export async function request<T>(options: RequestOptions<T>): Promise<T> {
  const { url, method = 'GET', params, data, schema, signal } = options;

  if (!checkApiPermission(url)) {
    throw new ApiError('PERMISSION_DENIED', `${ERROR_MSG.API_PERMISSION_DENIED} ${url}`);
  }

  let uri = `${BASE_URL}${url}`;
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (method === 'GET' && params) {
    // 替换 + 为 %20，避免空格被编码成 +
    const qs = new URLSearchParams(
      camel2Under(params) as Record<string, string>,
    )
      .toString()
      .replaceAll('+', '%20');
    if (qs) uri += `?${qs}`;
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(camel2Under(data));
  }

  const res = await fetch(uri, { method, headers, body, signal });

  if (res.status === 401) {
    clearToken();
    unauthorizedHandler();
    throw new ApiError('401', ERROR_MSG.NOT_LOGIN);
  }
  if (!res.ok) {
    throw new ApiError(String(res.status), `HTTP ${res.status} ${res.statusText}`);
  }

  // 响应整体 snake_case → camelCase
  const payload = under2Camel((await res.json()) as Record<string, unknown>) as {
    code: string;
    msg: string;
    info: unknown;
  };

  if (payload.code !== '0') {
    if (payload.code === ERROR_CODE.NOT_LOGIN) {
      clearToken();
      unauthorizedHandler();
    }
    throw new ApiError(payload.code, BUSINESS_ERROR_MSG[payload.code] ?? payload.msg);
  }

  if (!schema) return payload.info as T;

  // Zod 运行时校验：接口契约破坏时在边界处报错，而不是渲染时 NPE
  const parsed = schema.safeParse(payload.info);
  if (!parsed.success) {
    throw new ApiError(payload.code, '响应数据不符合 Zod Schema', parsed.error);
  }
  return parsed.data;
}

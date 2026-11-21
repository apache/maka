/**
 * 锤锤微软工具箱 — 免导入接口邮件适配器。
 *
 * 通过锤锤 API 的 /api/open/email/direct/latest 接口，直接传入 Outlook
 * OAuth2 凭证（不导入邮箱），获取最新一封邮件并提取验证码。
 *
 * 使用场景：用户有大量 Outlook 邮箱，不需逐个导入系统，只需传入凭证即可收信。
 *
 * API 格式：
 *   GET https://ms.outlook007.cc/api/open/email/direct/latest
 *     ?api_key={key}&credential={email}----{password}----{client_id}----{refresh_token}
 *
 * 响应：
 *   { code: 0, data: { body_content, subject, from, received_at, ... } }
 */
import { extractMailCode } from './mailCodeParser.js';
import type { OtpCode } from '../../types/brand.js';

export interface CuiCuiCredential {
  /** Outlook 邮箱地址。 */
  readonly email: string;
  /** 邮箱密码。 */
  readonly password: string;
  /** OAuth2 client_id。 */
  readonly clientId: string;
  /** OAuth2 refresh_token。 */
  readonly refreshToken: string;
}

export interface CuiCuiMailProviderOptions {
  /** 锤锤 API 密钥。 */
  readonly apiKey: string;
  /** API 基础 URL，默认 https://ms.outlook007.cc。 */
  readonly apiBaseUrl?: string;
  /** 请求超时(ms)，默认 15s。 */
  readonly timeoutMs?: number;
}

export interface CuiCuiMailResult {
  /** 邮件主题。 */
  subject: string;
  /** 发件人。 */
  from: string;
  /** 邮件正文(HTML)。 */
  bodyContent: string;
  /** 邮件正文纯文本预览。 */
  bodyPreview: string;
  /** 收件时间(ISO 8601)。 */
  receivedAt: string;
  /** 收件人。 */
  to: string;
  /** 提取到的验证码，若无则 null。 */
  code: OtpCode | null;
}

/**
 * 锤锤 API 邮箱适配器。
 * 包装免导入接口，提供 fetchLatest + pollForCode 两个核心方法。
 */
export class CuiCuiMailProvider {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CuiCuiMailProviderOptions) {
    if (!opts.apiKey) throw new Error('CuiCuiMailProvider: apiKey 必填');
    this.apiBaseUrl = opts.apiBaseUrl ?? 'https://ms.outlook007.cc';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** 获取指定邮箱的最新邮件(一次 API 调用)。 */
  async fetchLatest(cred: CuiCuiCredential): Promise<CuiCuiMailResult> {
    const credentialStr = `${cred.email}----${cred.password}----${cred.clientId}----${cred.refreshToken}`;
    const url = new URL('/api/open/email/direct/latest', this.apiBaseUrl);
    url.searchParams.set('api_key', this.opts.apiKey);
    url.searchParams.set('credential', credentialStr);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(url.toString(), { signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`锤锤 API HTTP ${resp.status}: ${resp.statusText}`);
      }
      const json = (await resp.json()) as {
        code: number;
        message?: string;
        data?: {
          subject?: string;
          from?: string;
          to?: string;
          body_content?: string;
          body_preview?: string;
          body_type?: string;
          received_at?: string;
        };
      };

      if (json.code !== 0) {
        throw new Error(`锤锤 API 错误(code=${json.code}): ${json.message ?? '未知'}`);
      }

      const d = json.data ?? {};
      const bodyContent = d.body_content ?? '';
      const bodyPreview = d.body_preview ?? '';
      const subject = d.subject ?? '';

      // 从邮件主题 + 正文中提取验证码
      const code = extractMailCode(`${subject} ${bodyPreview}`, bodyContent);

      return {
        subject,
        from: d.from ?? '',
        bodyContent,
        bodyPreview,
        receivedAt: d.received_at ?? '',
        to: d.to ?? cred.email,
        code,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轮询邮箱直到收到验证码或超时。
   *
   * @param cred 邮箱凭证
   * @param intervalMs 轮询间隔(ms)，默认 5000
   * @param maxAttempts 最大轮询次数，默认 20 (5s × 20 = 100s)
   * @returns 提取到的验证码
   * @throws 轮询超时
   */
  async pollForCode(
    cred: CuiCuiCredential,
    intervalMs = 5_000,
    maxAttempts = 20,
  ): Promise<OtpCode> {
    // 先取一次，记录基线邮件 ID（用于检测新邮件）
    let baselineId: string | null = null;
    try {
      const first = await this.fetchLatest(cred);
      baselineId = (first as unknown as { id?: string }).id ?? null;
      if (first.code) return first.code;
    } catch {
      // 基线获取失败不阻塞，直接进入轮询
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await sleep(intervalMs);
      try {
        const result = await this.fetchLatest(cred);
        // 检查是否是新邮件（ID 不同或没有基线）
        const currentId = (result as unknown as { id?: string }).id ?? null;
        if (baselineId && currentId === baselineId && attempt < 3) {
          // 前 2 轮邮件未更新是正常的，继续等待
          continue;
        }
        if (result.code) return result.code;
      } catch (err) {
        // 单次失败不放弃，继续轮询
        if (attempt === maxAttempts) throw err;
      }
    }
    throw new Error(`锤锤 API 轮询超时: ${cred.email} (${maxAttempts} 次/${intervalMs}ms)`);
  }
}

/** 解析凭证文件的一行（格式: email----password----client_id----refresh_token）。 */
export function parseCredentialLine(line: string): CuiCuiCredential | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('----');
  if (parts.length !== 4) return null;
  const [email, password, clientId, refreshToken] = parts as [string, string, string, string];
  if (!email || !password || !clientId || !refreshToken) return null;
  return { email, password, clientId, refreshToken };
}

/** 从凭证文件（每行一条）中解析全部邮箱凭证。 */
export function parseCredentialFile(content: string): CuiCuiCredential[] {
  return content
    .split('\n')
    .map(parseCredentialLine)
    .filter((c): c is CuiCuiCredential => c !== null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

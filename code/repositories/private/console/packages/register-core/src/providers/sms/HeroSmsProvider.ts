/**
 * HeroSMS 短信提供商实现(SMS-Activate 兼容协议)。
 * 迁移自现有 smsProvider.js,改造点:TS 类型、错误归一为 GetNumberError、
 * HTTP 客户端可注入(便于单测 mock)、品牌类型 PhoneNumber/OtpCode。
 */
import type { AxiosInstance } from 'axios';
import { asOtp, asPhone, type OtpCode, type PhoneNumber } from '../../types/brand.js';
import { createHttpClient } from '../../infra/http.js';
import {
    GetNumberError,
    SmsTimeoutError,
    type AcquiredNumber,
    type SmsProvider,
    type SmsPollOptions,
    type SmsStatus,
} from './SmsProvider.js';

const HERO_SMS_BASE = 'https://hero-sms.com/stubs/handler_api.php';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HeroSmsProviderOptions {
    apiKey: string;
    /** 可注入 HTTP 客户端(测试用);默认创建带 30s 超时的实例。 */
    httpClient?: AxiosInstance;
}

interface GetNumberV2Response {
    activationId: string | number;
    phoneNumber: string;
    activationCost?: number;
}

interface GetStatusV2Response {
    sms?: { code?: string };
}

export class HeroSmsProvider implements SmsProvider {
    readonly name = 'herosms' as const;
    private readonly http: AxiosInstance;
    private activationId: string | number | null = null;
    private phoneNumber: PhoneNumber | null = null;

    constructor(private readonly opts: HeroSmsProviderOptions) {
        if (!opts.apiKey) throw new Error('HeroSmsProvider: apiKey 必填');
        this.http = opts.httpClient ?? createHttpClient({ timeoutMs: 30_000 });
    }

    private async request(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
        const resp = await this.http.get(HERO_SMS_BASE, {
            params: { api_key: this.opts.apiKey, action, ...params },
        });
        return resp.data;
    }

    async getNumber(service: string, country: number | string, maxRetries = 5): Promise<AcquiredNumber> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let data: unknown;
            try {
                data = await this.request('getNumberV2', { service, country });
            } catch (e) {
                if (attempt < maxRetries) {
                    await sleep(5000);
                    continue;
                }
                throw new GetNumberError('NETWORK', e);
            }

            if (typeof data === 'string') {
                if (data === 'NO_BALANCE') throw new GetNumberError('NO_BALANCE');
                if (data === 'BAD_KEY') throw new GetNumberError('BAD_KEY');
                if (data === 'NO_NUMBERS') {
                    if (attempt < maxRetries) {
                        await sleep(3000);
                        continue;
                    }
                    throw new GetNumberError('NO_NUMBERS');
                }
                throw new GetNumberError('NETWORK');
            }

            const d = data as GetNumberV2Response;
            this.activationId = d.activationId;
            let phone = String(d.phoneNumber);
            if (!phone.startsWith('+')) phone = `+${phone}`;
            this.phoneNumber = asPhone(phone);
            return { activationId: this.activationId, phoneNumber: this.phoneNumber, costUsd: d.activationCost };
        }
        throw new GetNumberError('NETWORK');
    }

    async markReady(): Promise<void> {
        if (this.activationId == null) throw new Error('HeroSmsProvider.markReady: 尚未获取号码');
        await this.request('setStatus', { id: this.activationId, status: 1 });
    }

    async getStatus(): Promise<SmsStatus> {
        if (this.activationId == null) throw new Error('HeroSmsProvider.getStatus: 尚未获取号码');
        const data = await this.request('getStatusV2', { id: this.activationId });

        if (typeof data === 'string') {
            if (data === 'STATUS_WAIT_CODE') return { received: false };
            if (data === 'STATUS_CANCEL') throw new Error('HeroSMS 激活已被取消');
            if (data.startsWith('STATUS_OK:')) return { received: true, code: asOtp(data.slice('STATUS_OK:'.length)) };
            return { received: false };
        }
        const code = (data as GetStatusV2Response)?.sms?.code;
        return code ? { received: true, code: asOtp(code) } : { received: false };
    }

    async pollForCode(opts: SmsPollOptions = {}): Promise<OtpCode> {
        const intervalMs = opts.intervalMs ?? 5_000;
        const maxAttempts = opts.maxAttempts ?? 60;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await this.getStatus();
                if (result.received && result.code) return result.code;
            } catch {
                // 单次查询出错不中断轮询
            }
            await sleep(intervalMs);
        }
        throw new SmsTimeoutError(`HeroSMS 验证码超时(等待 ${Math.round((maxAttempts * intervalMs) / 1000)}s)`);
    }

    async complete(): Promise<void> {
        if (this.activationId == null) return;
        await this.request('setStatus', { id: this.activationId, status: 6 });
    }

    async cancel(): Promise<void> {
        if (this.activationId == null) return;
        try {
            await this.request('setStatus', { id: this.activationId, status: 8 });
        } catch {
            // 409 EARLY_CANCEL_DENIED 等:平台超时后自动退款,不阻塞主流程
        }
    }

    getPhone(): PhoneNumber | null {
        return this.phoneNumber;
    }
}

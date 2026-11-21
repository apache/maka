/**
 * 短信验证码提供商抽象接口。
 * 容纳 HeroSMS(SMS-Activate 协议)和 5sim(RESTful)两种实现,方法名同构。
 * 生命周期:getNumber(买号) → markReady(准备收码) → pollForCode(轮询取码) → complete/cancel。
 */
import type { OtpCode, PhoneNumber } from '../../types/brand.js';

export type ActivationId = string | number;

export interface AcquiredNumber {
    readonly activationId: ActivationId;
    readonly phoneNumber: PhoneNumber;
    readonly costUsd?: number;
}

export interface SmsPollOptions {
    readonly intervalMs?: number;
    readonly maxAttempts?: number;
}

export interface SmsStatus {
    readonly received: boolean;
    readonly code?: OtpCode;
}

export type SmsProviderName = 'herosms' | 'fivesim';

/** 获取号码失败的细粒度原因,便于上层(HealingPolicy)决策换号/告警。 */
export class GetNumberError extends Error {
    constructor(
        public readonly reason: 'NO_BALANCE' | 'BAD_KEY' | 'NO_NUMBERS' | 'NETWORK',
        cause?: unknown,
    ) {
        super(`获取号码失败 (${reason})`, cause !== undefined ? { cause } : undefined);
        this.name = 'GetNumberError';
    }
}

export class SmsTimeoutError extends Error {
    constructor(message = '短信验证码轮询超时') {
        super(message);
        this.name = 'SmsTimeoutError';
    }
}

export interface SmsProvider {
    readonly name: SmsProviderName;
    /** 申请号码。失败按实现重试,最终抛 GetNumberError。 */
    getNumber(service: string, country: number | string, maxRetries?: number): Promise<AcquiredNumber>;
    /** 标记准备接收(HeroSMS 需要 status=1;5sim no-op)。 */
    markReady(): Promise<void>;
    /** 单次查询激活状态。 */
    getStatus(): Promise<SmsStatus>;
    /** 轮询直到拿到验证码或超时(抛 SmsTimeoutError)。 */
    pollForCode(opts?: SmsPollOptions): Promise<OtpCode>;
    /** 确认完成(释放号码、扣费结算)。 */
    complete(): Promise<void>;
    /** 取消(部分退款)。错误不应抛出到主流程。 */
    cancel(): Promise<void>;
    /** 当前号码(未获取时为 null)。 */
    getPhone(): PhoneNumber | null;
}

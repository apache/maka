/**
 * SMS 验证码提取(纯函数)。
 * 5sim 的 /check 接口只返回短信原文,需要自己从文本里抠验证码;
 * HeroSMS 的 getStatusV2 服务端直接给码,无需此函数。
 * 迁移自现有 fiveSimProvider.js 的 _extractCodeFromSmsItem。
 */
import { asOtp, type OtpCode } from '../../types/brand.js';

const CODE_PATTERNS: readonly RegExp[] = [
    /(?:code|验证码|verification|verify|otp)[^\d]{0,30}(\d{4,8})/i,
    /(\d{4,8})[^\d]{0,30}(?:code|验证码|verification|verify|otp)/i,
];

/**
 * 从短信文本提取 4-8 位验证码。
 * 先按关键词上下文匹配,兜底取第一个独立数字串。
 */
export function extractSmsCode(text: string): OtpCode | null {
    if (!text || typeof text !== 'string') return null;
    for (const pattern of CODE_PATTERNS) {
        const match = text.match(pattern);
        if (match?.[1]) return asOtp(match[1]);
    }
    const fallback = text.match(/\b(\d{4,8})\b/);
    return fallback?.[1] ? asOtp(fallback[1]) : null;
}

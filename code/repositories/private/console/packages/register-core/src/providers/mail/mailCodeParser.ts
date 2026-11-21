/**
 * 邮箱验证码提取(纯函数)。
 * 从邮件正文里抠 6 位 OTP,多级正则 + 兜底过滤 MIME 噪声。
 * 迁移自现有 index.js 的 extractVerificationCodeFromBody。
 */
import { asOtp, type OtpCode } from '../../types/brand.js';

const CODE_PATTERNS: readonly RegExp[] = [
    /(?:code|验证码|verification|verify)[^\d]{0,30}(\d{6})/i,
    /(\d{6})[^\d]{0,30}(?:code|验证码|verification)/i,
    />\s*(\d{6})\s*</,
];

/**
 * 从邮件正文提取 6 位验证码。
 * @param body 已提取的正文(由 buildMailBody 产出)
 * @param raw  原始 MIME(用于噪声过滤,可选)
 */
export function extractMailCode(body: string, raw: string = ''): OtpCode | null {
    if (!body || typeof body !== 'string') return null;

    for (const pattern of CODE_PATTERNS) {
        const match = body.match(pattern);
        if (match?.[1]) return asOtp(match[1]);
    }

    // 兜底:所有独立 6 位数,排除 MIME boundary/时间戳噪声(t=123456 / x=123456)
    const allSixDigits = body.match(/\b(\d{6})\b/g) ?? [];
    const filtered = allSixDigits.filter((d) => !raw.includes(`t=${d}`) && !raw.includes(`x=${d}`));
    return filtered[0] ? asOtp(filtered[0]) : null;
}

/**
 * 浏览器指纹随机化:批量注册时为每个账号生成不同的浏览器特征,
 * 降低 OpenAI 风控系统通过指纹聚类识别自动化注册的概率。
 *
 * 覆盖维度:viewport、language、timezone、platform、deviceMemory、hardwareConcurrency。
 * puppeteer-real-browser 的 rebrowser-patches 已覆盖 navigator.webdriver 等基础指纹,
 * 本模块负责"多样性",两者互补。
 */
import { randomInt } from 'node:crypto';

export interface FingerprintProfile {
    /** 视口分辨率。 */
    readonly viewport: { width: number; height: number };
    /** 浏览器语言(如 zh-CN / en-US)。 */
    readonly lang: string;
    /** 对应语言的时区(如 Asia/Shanghai / America/New_York)。 */
    readonly timezone: string;
    /** navigator.platform 值(Win32 / MacIntel 等)。 */
    readonly platform: string;
    /** 设备内存(GB),navigator.deviceMemory。 */
    readonly deviceMemory: number;
    /** 逻辑核心数,navigator.hardwareConcurrency。 */
    readonly hardwareConcurrency: number;
}

/**
 * 指纹池:模拟真实用户的浏览器环境组合。
 * 语言和时区保持地理一致性(en-US → America/New_York, zh-CN → Asia/Shanghai)。
 */
const FINGERPRINT_POOL: readonly FingerprintProfile[] = [
    { viewport: { width: 1920, height: 1080 }, lang: 'en-US', timezone: 'America/New_York', platform: 'Win32', deviceMemory: 16, hardwareConcurrency: 16 },
    { viewport: { width: 1920, height: 1080 }, lang: 'en-US', timezone: 'America/Chicago', platform: 'Win32', deviceMemory: 8, hardwareConcurrency: 8 },
    { viewport: { width: 2560, height: 1440 }, lang: 'en-US', timezone: 'America/Los_Angeles', platform: 'MacIntel', deviceMemory: 32, hardwareConcurrency: 12 },
    { viewport: { width: 1366, height: 768 }, lang: 'en-GB', timezone: 'Europe/London', platform: 'Win32', deviceMemory: 8, hardwareConcurrency: 4 },
    { viewport: { width: 1440, height: 900 }, lang: 'en-GB', timezone: 'Europe/London', platform: 'MacIntel', deviceMemory: 16, hardwareConcurrency: 8 },
    { viewport: { width: 1920, height: 1080 }, lang: 'zh-CN', timezone: 'Asia/Shanghai', platform: 'Win32', deviceMemory: 16, hardwareConcurrency: 12 },
    { viewport: { width: 1920, height: 1080 }, lang: 'zh-CN', timezone: 'Asia/Shanghai', platform: 'Win32', deviceMemory: 8, hardwareConcurrency: 8 },
    { viewport: { width: 1536, height: 864 }, lang: 'zh-TW', timezone: 'Asia/Taipei', platform: 'Win32', deviceMemory: 8, hardwareConcurrency: 8 },
    { viewport: { width: 1920, height: 1080 }, lang: 'ja-JP', timezone: 'Asia/Tokyo', platform: 'Win32', deviceMemory: 16, hardwareConcurrency: 8 },
    { viewport: { width: 1920, height: 1080 }, lang: 'ja-JP', timezone: 'Asia/Tokyo', platform: 'MacIntel', deviceMemory: 16, hardwareConcurrency: 10 },
    { viewport: { width: 1440, height: 900 }, lang: 'ko-KR', timezone: 'Asia/Seoul', platform: 'Win32', deviceMemory: 8, hardwareConcurrency: 8 },
    { viewport: { width: 1920, height: 1080 }, lang: 'de-DE', timezone: 'Europe/Berlin', platform: 'Win32', deviceMemory: 16, hardwareConcurrency: 12 },
    { viewport: { width: 1920, height: 1080 }, lang: 'fr-FR', timezone: 'Europe/Paris', platform: 'MacIntel', deviceMemory: 16, hardwareConcurrency: 8 },
    { viewport: { width: 1366, height: 768 }, lang: 'pt-BR', timezone: 'America/Sao_Paulo', platform: 'Win32', deviceMemory: 4, hardwareConcurrency: 4 },
    { viewport: { width: 1920, height: 1080 }, lang: 'es-ES', timezone: 'Europe/Madrid', platform: 'Win32', deviceMemory: 16, hardwareConcurrency: 8 },
];

/**
 * 从指纹池中随机选取一个,并微调分辨率(±5% 内)模拟不同用户的显示器差异。
 */
export function randomizeFingerprint(): FingerprintProfile {
    const base = FINGERPRINT_POOL[randomInt(FINGERPRINT_POOL.length)]!;

    // 分辨率微调:±3% 范围内变化,避免完全相同的分辨率
    const jitterW = 1 + (Math.random() * 0.06 - 0.03);
    const jitterH = 1 + (Math.random() * 0.06 - 0.03);

    return {
        ...base,
        viewport: {
            width: Math.round(base.viewport.width * jitterW),
            height: Math.round(base.viewport.height * jitterH),
        },
    };
}

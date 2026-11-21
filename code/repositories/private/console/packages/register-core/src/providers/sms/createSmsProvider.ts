/**
 * 短信提供商工厂:按 config.sms.provider 选择实现。
 * HeroSMS 已实现;5sim 留接口 + TODO(双渠道抽象已由接口保证,实现按需增量)。
 */
import type { AppConfig } from '../../config/schema.js';
import type { SmsProvider } from './SmsProvider.js';
import { HeroSmsProvider } from './HeroSmsProvider.js';

export function createSmsProvider(cfg: AppConfig): SmsProvider {
    switch (cfg.sms.provider) {
        case 'herosms':
            return new HeroSmsProvider({ apiKey: cfg.sms.herosms.apiKey });
        case 'fivesim':
            // TODO: FiveSimProvider 实现(接口已就绪,迁移 fiveSimProvider.js + 复用 smsCodeParser)。
            throw new Error('createSmsProvider: 5sim 渠道尚未实现(留作接口增量示范)');
        default: {
            const exhaustive: never = cfg.sms.provider;
            throw new Error(`createSmsProvider: 未知 provider ${String(exhaustive)}`);
        }
    }
}

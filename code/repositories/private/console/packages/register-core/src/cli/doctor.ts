/** doctor:启动前环境自检(配置校验、依赖可加载、SQLite 可写、代理可达)。 */
import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../persistence/db.js';
import { maskSecret } from '../logging/logger.js';

export interface DoctorOptions {
    config?: string;
}

export async function cmdDoctor(opts: DoctorOptions): Promise<void> {
    console.log('[doctor] 1/4 加载并校验配置...');
    let cfg;
    try {
        cfg = loadConfig({ configPath: opts.config });
    } catch (e) {
        console.error(`[doctor] 配置校验失败: ${(e as Error).message}`);
        process.exitCode = 2;
        return;
    }
    console.log('  ✓ 配置校验通过');
    console.log(`    sms.provider     = ${cfg.sms.provider}`);
    console.log(`    mail.provider    = ${cfg.mail.provider}`);
    console.log(`    browser.engine   = ${cfg.browser.engine}`);
    console.log(`    heroSms.apiKey   = ${maskSecret(cfg.sms.herosms.apiKey)}`);
    console.log(`    mailAdminPass    = ${maskSecret(cfg.mail.legacy.adminPassword)}`);
    console.log(`    proxy            = ${cfg.proxy ? `${cfg.proxy.host}:${cfg.proxy.port}` : '(未配置,直连)'}`);
    console.log(`    rateLimit        = ${cfg.compliance.maxAccountsPerHour}/hour, 间隔 ${cfg.compliance.minDelayMs}ms`);

    console.log('[doctor] 2/4 检查关键依赖...');
    const deps = ['puppeteer-real-browser', 'pino', 'zod', 'axios', 'dotenv'];
    for (const dep of deps) {
        try {
            await import(dep);
            console.log(`  ✓ ${dep}`);
        } catch {
            console.error(`  ✗ ${dep} 加载失败`);
            process.exitCode = 2;
        }
    }

    console.log('[doctor] 3/4 检查 SQLite...');
    try {
        const db = openDatabase(cfg.database.path);
        db.prepare('SELECT 1').get();
        db.close();
        console.log(`  ✓ ${cfg.database.path}`);
    } catch (e) {
        console.error(`  ✗ SQLite 失败: ${(e as Error).message}`);
        process.exitCode = 2;
    }

    console.log('[doctor] 4/4 完成。如需端到端运行,请配置真实 API key/代理后执行 register。');
}

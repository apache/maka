/**
 * CDK API 端到端验证脚本。
 * 用真实 CDK token 测试 CdkMailProvider 的完整链路。
 *
 * 使用方式:
 *   1. 在 .env 中设置 REG_MAIL_PROVIDER=cdk + CDK_KEY + CDK_EMAIL
 *   2. pnpm exec tsx tests/manual/verify-cdk.ts
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../.env') });

import { createMailProvider } from '../../src/providers/mail/createMailProvider.js';
import { loadConfig } from '../../src/config/loader.js';
import { extractMailCode } from '../../src/providers/mail/mailCodeParser.js';
import { buildMailBody } from '../../src/providers/mail/mailBodyBuilder.js';

async function main() {
    console.log('=== CDK API 端到端验证 ===\n');

    // 1. 加载配置
    console.log('[1/4] 加载配置...');
    const cfg = loadConfig();
    console.log(`  mail.provider   = ${cfg.mail.provider}`);
    console.log(`  mail.cdk.cdkKey = ${cfg.mail.cdk.cdkKey ? cfg.mail.cdk.cdkKey.slice(0, 15) + '...' : '(未设置)'}`);
    console.log(`  mail.cdk.email  = ${cfg.mail.cdk.email || '(未设置)'}`);
    console.log(`  apiBaseUrl      = ${cfg.mail.cdk.apiBaseUrl}`);

    if (cfg.mail.provider !== 'cdk') {
        console.error('\n❌ REG_MAIL_PROVIDER 不是 cdk，当前值:', cfg.mail.provider);
        process.exit(1);
    }
    if (!cfg.mail.cdk.cdkKey || !cfg.mail.cdk.email) {
        console.error('\n❌ CDK_KEY 或 CDK_EMAIL 未设置');
        process.exit(1);
    }

    // 2. 创建 provider + createAddress
    console.log('\n[2/4] 创建 CdkMailProvider...');
    const mail = createMailProvider(cfg);
    const created = await mail.createAddress();
    console.log(`  ✅ provider.name = ${mail.name}`);
    console.log(`  📧 邮箱地址 = ${created.address}`);
    console.log(`  🔑 cdkKey    = ${created.session.cdkKey}`);

    // 3. 拉取最新邮件
    console.log('\n[3/4] 拉取最新邮件...');
    const mails = await mail.getMails(5);
    console.log(`  ✅ 获取到 ${mails.length} 封邮件`);

    if (mails.length === 0) {
        console.log('  ℹ️  邮箱为空(尚未收到 ChatGPT 验证邮件或其他邮件)');
        console.log('  💡 正常现象 —— 该 CDK 邮箱可能还未触发 ChatGPT 发验证码');
    }

    for (const m of mails) {
        console.log(`\n  ── 最新邮件 ──`);
        console.log(`    主题:   ${m.subject?.slice(0, 80) ?? '(无)'}`);
        console.log(`    发件人: ${typeof m.from === 'object' && m.from ? (m.from as { address: string }).address : '(无)'}`);
        console.log(`    时间:   ${m.createdAt ?? '(无)'}`);

        const body = buildMailBody({ text: m.text, html: m.html, raw: m.raw });
        const code = extractMailCode(body, m.raw ?? '');

        if (code) {
            console.log(`    🔑 提取到验证码: ${code}`);
        } else if (body) {
            const preview = body.slice(0, 200).replace(/\s+/g, ' ');
            console.log(`    📄 正文预览: ${preview}...`);
        }
    }

    // 4. session 导出
    console.log('\n[4/4] session 导出...');
    const session = mail.exportSession();
    if (session) {
        console.log(`  ✅ provider: ${session.provider}, address: ${session.address}`);
    }

    console.log('\n=== ✅ CDK API 验证通过 ===');
}

main().catch((e) => {
    console.error('\n❌ 错误:', e);
    process.exit(1);
});

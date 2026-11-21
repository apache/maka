/**
 * IMAP 端到端验证脚本。
 * 验证 ImapMailProvider 的完整链路:连接 → 收信 → 验证码提取。
 *
 * 使用方式:
 *   1. 在 .env 中设置 REG_MAIL_PROVIDER=imap + IMAP_USER + IMAP_PASSWORD
 *   2. pnpm exec tsx tests/manual/verify-imap.ts
 */
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 加载 .env(兼容 Node 20)
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../.env') });

import { createMailProvider } from '../../src/providers/mail/createMailProvider.js';
import { loadConfig } from '../../src/config/loader.js';
import { extractMailCode } from '../../src/providers/mail/mailCodeParser.js';
import { buildMailBody } from '../../src/providers/mail/mailBodyBuilder.js';

async function main() {
    console.log('=== IMAP 端到端验证 ===\n');

    // 1. 加载配置
    console.log('[1/5] 加载配置...');
    const cfg = loadConfig();
    console.log(`  mail.provider = ${cfg.mail.provider}`);
    console.log(`  mail.imap.user = ${cfg.mail.imap.user || '(未设置)'}`);
    console.log(`  mail.imap.host = ${cfg.mail.imap.host || '(自动推断)'}`);
    console.log(`  mail.imap.port = ${cfg.mail.imap.port}`);

    if (cfg.mail.provider !== 'imap') {
        console.error('\n❌ 错误: REG_MAIL_PROVIDER 未设置为 imap，当前值:', cfg.mail.provider);
        process.exit(1);
    }
    if (!cfg.mail.imap.user || !cfg.mail.imap.password) {
        console.error('\n❌ 错误: IMAP_USER 或 IMAP_PASSWORD 未设置');
        process.exit(1);
    }

    // 2. 创建 provider
    console.log('\n[2/5] 创建 ImapMailProvider...');
    const mail = createMailProvider(cfg);
    console.log(`  provider.name = ${mail.name}`);

    // 3. createAddress(验证 IMAP 连通性)
    console.log('\n[3/5] 测试 IMAP 连接与认证...');
    let created;
    try {
        created = await mail.createAddress();
        console.log(`  ✅ 连接成功`);
        console.log(`  📧 邮箱地址: ${created.address}`);
        console.log(`  🔑 session.provider: ${created.session.provider}`);
    } catch (e) {
        console.error(`  ❌ 连接/认证失败: ${(e as Error).message}`);
        console.error('  排查建议:');
        console.error('    - Outlook/Hotmail: 需在 Microsoft 账号安全中生成"应用密码"');
        console.error('    - Gmail: 需开启两步验证后生成"应用专用密码"');
        console.error('    - QQ/163: 需在邮箱设置中开启 IMAP 并用"授权码"');
        console.error('    - 检查是否被公司/学校 IT 策略禁用 IMAP');
        process.exit(1);
    }

    // 4. 拉取最近邮件
    console.log('\n[4/5] 拉取最近 5 封邮件...');
    try {
        const mails = await mail.getMails(5, 0);
        console.log(`  ✅ 获取到 ${mails.length} 封邮件`);

        for (const m of mails) {
            console.log(`\n  ── 邮件 ──`);
            console.log(`    ID:      ${m.id ?? '(无)'}`);
            console.log(`    主题:    ${m.subject ?? '(无主题)'}`);
            console.log(`    发件人:  ${typeof m.from === 'object' && m.from ? (m.from as { address: string }).address : '(无)'}`);
            console.log(`    时间:    ${m.createdAt ?? '(无)'}`);

            // 5. 验证码提取
            const body = buildMailBody({ text: m.text, html: m.html, raw: m.raw });
            const code = extractMailCode(body, m.raw ?? '');

            if (code) {
                console.log(`    🔑 提取到验证码: ${code}`);
            } else if (body) {
                const preview = body.slice(0, 120).replace(/\s+/g, ' ');
                console.log(`    📄 正文预览: ${preview}...`);
            }
        }
    } catch (e) {
        console.error(`  ❌ 拉取邮件失败: ${(e as Error).message}`);
        process.exit(1);
    }

    // 6. 导出 session(验证可持久化)
    console.log('\n[5/5] 导出 session...');
    const session = mail.exportSession();
    if (session) {
        console.log(`  ✅ session 导出成功`);
        console.log(`    provider: ${session.provider}`);
        console.log(`    address: ${session.address}`);
        console.log(`    imapUser: ${session.imapUser ?? '(无)'}`);
        console.log(`    imapPassword: ${session.imapPassword ? '***已存储***' : '(无)'}`);
    } else {
        console.log('  ⚠️  session 为空(未连接?)');
    }

    console.log('\n=== ✅ 所有验证通过 ===');
    console.log('ImapMailProvider 端到端链路正常:连接→收信→解析→验证码提取→session导出');
}

main().catch((e) => {
    console.error('\n❌ 未预期的错误:', e);
    process.exit(1);
});

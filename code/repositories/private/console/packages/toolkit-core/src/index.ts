/**
 * toolkit-core 命令工厂：registration-toolkit 独有工具（去重后）挂载进 console-cli。
 */
import { Command } from 'commander';
import { runBatchEmail } from './batch-email.js';

export function createToolkitCommand(): Command {
    const toolkit = new Command('toolkit');

    toolkit.description('registration-toolkit 独有工具(batch-email 等)');

    toolkit
        .command('batch-email')
        .description('Outlook 邮箱 + 锤锤 API 批量注册 ChatGPT Free(开真浏览器,需 OUTLOOK007_API_KEY)')
        .requiredOption('--creds <path>', 'Outlook 凭证文件(email----password----client_id----refresh_token)')
        .option('--out <dir>', '输出目录(token JSON 与日志)', process.env.OUTLOOK007_OUT_DIR)
        .option('--count <n>', '只跑前 N 个', parseInt)
        .option('--start <n>', '起始序号(1 起)', parseInt)
        .action(async (opts: { creds: string; out?: string; count?: number; start?: number }) => {
            const sum = await runBatchEmail({
                creds: opts.creds,
                out: opts.out,
                count: Number.isFinite(opts.count) ? opts.count : undefined,
                start: Number.isFinite(opts.start) ? opts.start : undefined,
            });
            console.log(`DONE: ${sum.success}/${sum.total}`);
        });

    return toolkit;
}

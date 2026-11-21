/**
 * CLI 命令工厂:注册 commander 子命令组(register/resume/doctor/report)。
 * 供 apps/cli 挂载,也可独立执行(直接运行本文件)。
 */
import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { cmdRegister, cmdResume, cmdReport } from './cli/commands.js';
import { cmdDoctor } from './cli/doctor.js';

// toolkit-core 的 batch-email 等外部工具所需的引擎部件（自 registration-toolkit 迁入）。
export { PuppeteerRealAdapter } from './browser/PuppeteerRealAdapter.js';
export { OAuthClient } from './oauth/OAuthClient.js';
export { generateIdentity, generatePassword } from './flows/IdentityGenerator.js';
export { CuiCuiMailProvider, parseCredentialFile, parseCredentialLine } from './providers/mail/CuiCuiMailProvider.js';
export type { CuiCuiCredential } from './providers/mail/CuiCuiMailProvider.js';
export type { AppConfig } from './config/schema.js';

export function createRegisterCommand(): Command {
    const register = new Command('register');

    register.description('GPT Free Register 注册引擎(run/doctor/report)')
        .option('-c, --config <path>', 'config 文件路径');

    register
        .command('run <count>')
        .description('批量注册指定数量账号(Phase 1→2→3 完整流程)')
        .option('-c, --config <path>', 'config 文件路径')
        .option('--no-confirm', '跳过启动合规确认(默认需确认)')
        .action(async (count: string, opts: { config?: string; confirm?: boolean }) => {
            await cmdRegister(parseInt(count, 10), opts);
        });

    register
        .command('resume')
        .description('从已绑定邮箱的账号恢复,用邮箱 OTP 重新换 token(对应 phase8,待实现)')
        .option('-c, --config <path>', 'config 文件路径')
        .action(async (opts: { config?: string }) => {
            await cmdResume(opts);
        });

    register
        .command('doctor')
        .description('启动前环境自检(配置/依赖/SQLite/代理)')
        .option('-c, --config <path>', 'config 文件路径')
        .action(async (opts: { config?: string }) => {
            await cmdDoctor(opts);
        });

    register
        .command('report [runId]')
        .description('查询历史运行报告(不传 runId 列最近 20 条)')
        .option('-c, --config <path>', 'config 文件路径')
        .action(async (runId: string | undefined, opts: { config?: string }) => {
            await cmdReport(runId, opts);
        });

    return register;
}

/** 直接执行本文件时作为独立 CLI 运行。 */
const scriptArg = process.argv[1];
if (scriptArg && import.meta.url === pathToFileURL(scriptArg).href) {
    createRegisterCommand().parseAsync(process.argv).catch((err: unknown) => {
        console.error(`[fatal] ${(err as Error)?.message ?? err}`);
        process.exit(1);
    });
}

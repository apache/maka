/**
 * 自愈策略:根据错误类型决策下一步动作(重试/换号/换邮箱/换代理/放弃)。
 * 把现有 index.js 里散落的 if-else 错误处理归一为可测的决策函数。
 *
 * 决策优先级:
 * 1. 硬错误(账号已停用/SSO 劫持) → 立即放弃,不浪费资源
 * 2. 动作错误(SignupActionError) → 重试,因为可能是瞬时 UI 问题
 * 3. 代理错误 → 换代理
 * 4. 验证码超时 → 换邮箱
 * 5. 重试耗尽 → 放弃
 */
export type HealingAction = 'retry' | 'changeNumber' | 'changeEmail' | 'switchProxy' | 'giveUp';

export interface HealingDecision {
    readonly action: HealingAction;
    readonly reason: string;
}

export interface HealingContext {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly phase: string;
}

/** 从错误链中提取所有消息文本(含 SignupActionError 的 state/action 上下文)。 */
export function extractErrorMessage(error: unknown): string {
    const messages: string[] = [];
    let current: unknown = error;
    while (current) {
        if (current instanceof Error) {
            messages.push(current.message);
            // SignupActionError 附加了 state/action 上下文
            const signupErr = current as { state?: string; action?: string };
            if (signupErr.state) messages.push(`state=${signupErr.state}`);
            if (signupErr.action) messages.push(`action=${signupErr.action}`);
            current = current.cause;
        } else {
            messages.push(String(current));
            break;
        }
    }
    return messages.join(' | ');
}

export class HealingPolicy {
    decide(error: unknown, ctx: HealingContext): HealingDecision {
        const msg = extractErrorMessage(error);

        // 硬错误:立即放弃
        if (/AccountDeactivated|ACCOUNT_DEACTIVATED/i.test(msg)) {
            return { action: 'giveUp', reason: '账号已被停用' };
        }
        if (/GoogleSso|accounts\.google\.com/i.test(msg)) {
            return { action: 'giveUp', reason: 'Google SSO 劫持' };
        }

        // 软错误:可恢复
        if (/rate.?limit|RATE_LIMITED/i.test(msg)) {
            if (ctx.attempt < ctx.maxAttempts) {
                return { action: 'retry', reason: `触发限流 (${ctx.attempt}/${ctx.maxAttempts}): ${msg.slice(0, 100)}` };
            }
            return { action: 'giveUp', reason: '触发限流且重试耗尽,建议换 IP 或增加间隔' };
        }
        if (/unusual.?activity|UNUSUAL_ACTIVITY/i.test(msg)) {
            return { action: 'switchProxy', reason: `异常活动检测,换代理: ${msg.slice(0, 100)}` };
        }
        if (/PhoneAlreadyRegistered|PHONE_ALREADY_REGISTERED/i.test(msg)) {
            return { action: 'changeNumber', reason: '手机号已注册' };
        }
        if (/PasswordIncorrect|PASSWORD_INCORRECT/i.test(msg)) {
            return { action: 'giveUp', reason: '密码错误' };
        }
        if (/EmailCodeTimeout|EMAIL_CODE_TIMEOUT/i.test(msg)) {
            return { action: 'changeEmail', reason: '邮箱验证码超时' };
        }
        if (/ERR_PROXY|ECONNREFUSED|tunnel/i.test(msg)) {
            return { action: 'switchProxy', reason: `代理连接失败: ${msg.slice(0, 120)}` };
        }

        // SignupActionError:浏览器操作失败 → 瞬时 UI 问题,重试
        if (/SignupActionError/i.test(msg) || /setInputValue|clickButton|onSmsCode/i.test(msg)) {
            if (ctx.attempt < ctx.maxAttempts) {
                return {
                    action: 'retry',
                    reason: `浏览器操作失败(尝试 ${ctx.attempt}/${ctx.maxAttempts}): ${msg.slice(0, 100)}`,
                };
            }
            return { action: 'giveUp', reason: `浏览器操作重试耗尽: ${msg.slice(0, 100)}` };
        }

        // 兜底
        if (ctx.attempt < ctx.maxAttempts) {
            return { action: 'retry', reason: `未识别错误 (${ctx.attempt}/${ctx.maxAttempts}): ${msg.slice(0, 120)}` };
        }
        return { action: 'giveUp', reason: `未识别错误且重试耗尽: ${msg.slice(0, 120)}` };
    }
}

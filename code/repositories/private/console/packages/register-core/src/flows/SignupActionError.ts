/**
 * 注册动作异常:当 Orchestrator 的浏览器操作(setInputValue/clickButtonByText 等)失败时抛,
 * 携带失败状态和原始错误信息,供 HealingPolicy 决策下一步动作(重试/换号/换代理/放弃)。
 *
 * 替代此前所有 .catch(() => {}) 的静默吞错模式。
 */
export class SignupActionError extends Error {
    /** 失败时状态机所处的状态(如 'PhoneEntry' / 'PasswordEntry')。 */
    readonly state: string;
    /** 失败的动作类型(如 'setInput' / 'clickButton')。 */
    readonly action: string;
    /** 原始错误(如果有)。 */
    readonly cause: unknown;

    constructor(state: string, action: string, message: string, cause?: unknown) {
        super(message);
        this.name = 'SignupActionError';
        this.state = state;
        this.action = action;
        this.cause = cause;
    }
}

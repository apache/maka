/**
 * 通用有限状态机(FSM)引擎:纯逻辑、不持有 IO,可单测。
 * 转移表(MachineDef)是数据,由 SignupFlow/OAuthFlow 定义;
 * 状态机只负责"给定当前状态 + 事件 + 快照,推进到下一状态"。
 */
import type { PageSnapshot } from './states.js';

export interface Transition<S extends string, E extends string> {
    /** 允许的来源状态(数组,支持多状态共用一条转移)。 */
    readonly from: readonly S[];
    readonly on: E;
    readonly to: S;
    /** 守卫:返回 false 则跳过本转移(用于需要快照细节的条件)。 */
    readonly guard?: (snapshot?: PageSnapshot) => boolean;
}

export interface MachineDef<S extends string, E extends string> {
    readonly initial: S;
    readonly terminals: ReadonlySet<S>;
    readonly transitions: ReadonlyArray<Transition<S, E>>;
}

export interface TransitionRecord<S extends string, E extends string> {
    readonly from: S;
    readonly to: S;
    readonly on: E;
}

export interface StepInput<E extends string> {
    readonly event: E;
    readonly snapshot?: PageSnapshot;
}

export class StateMachine<S extends string, E extends string> {
    private state: S;
    private readonly records: TransitionRecord<S, E>[] = [];

    constructor(private readonly def: MachineDef<S, E>) {
        this.state = def.initial;
    }

    get current(): S {
        return this.state;
    }

    getTrace(): readonly TransitionRecord<S, E>[] {
        return this.records;
    }

    isTerminal(): boolean {
        return this.def.terminals.has(this.state);
    }

    /** 尝试转移;匹配且 guard 通过则推进并返回 true,否则停留原状态。 */
    step(event: E, snapshot?: PageSnapshot): boolean {
        const from = this.state;
        for (const t of this.def.transitions) {
            if (t.on !== event) continue;
            if (!t.from.includes(from)) continue;
            if (t.guard && !t.guard(snapshot)) continue;
            this.state = t.to;
            this.records.push({ from, to: t.to, on: event });
            return true;
        }
        return false;
    }

    /** 按输入序列驱动(测试用),返回经历的状态序列。 */
    run(inputs: ReadonlyArray<StepInput<E>>): S[] {
        const visited: S[] = [this.state];
        for (const { event, snapshot } of inputs) {
            this.step(event, snapshot);
            visited.push(this.state);
        }
        return visited;
    }

    reset(): void {
        this.state = this.def.initial;
        this.records.length = 0;
    }
}

/// <reference lib="dom" />
/**
 * 页面内 JS 工具(注入浏览器执行):页面快照抓取 + React _valueTracker 绕过。
 * 这些函数必须"自包含"(不引用模块作用域),因为 puppeteer 会把它们 toString 后注入页面。
 * 三斜杠引入 dom lib 仅为本文件类型检查,不影响项目其余部分。
 */

/** 快照文本最大长度(避免 innerText 过大,但需足够覆盖常见错误页)。 */
const MAX_TEXT_LENGTH = 8000;

/** 快照级错误类型(与 states.ts 中的 SnapshotErrorType 保持同步)。 */
type SnapshotErrorType =
    | 'phone_registered'
    | 'account_deactivated'
    | 'google_sso_redirect'
    | 'password_incorrect'
    | 'rate_limited'
    | 'unusual_activity'
    | null;

/** 错误模式:正则 + 对应的错误类型。按优先级排列,靠前的先匹配。 */
interface ErrorPattern {
    regex: RegExp;
    type: NonNullable<SnapshotErrorType>;
}

const ERROR_PATTERNS: readonly ErrorPattern[] = [
    { regex: /phone.*(?:already|linked|registered|in use)/i, type: 'phone_registered' },
    { regex: /\d{7,}.*(?:already|linked|registered)/i, type: 'phone_registered' },
    { regex: /account.*deactivated/i, type: 'account_deactivated' },
    { regex: /deactivated/i, type: 'account_deactivated' },
    { regex: /incorrect.*password|password.*incorrect|wrong.*password/i, type: 'password_incorrect' },
    { regex: /too many (?:requests|attempts)|rate.?limit/i, type: 'rate_limited' },
    { regex: /unusual (?:activity|sign.?in)/i, type: 'unusual_activity' },
    { regex: /accounts\.google\.com/i, type: 'google_sso_redirect' },
];

/** 在完整文本上扫描错误(截断前执行,确保关键信息不丢失)。 */
function scanError(text: string): { errorType: SnapshotErrorType; errorContext: string } {
    for (const pattern of ERROR_PATTERNS) {
        const match = text.match(pattern.regex);
        if (match) {
            const idx = match.index ?? 0;
            const ctx = text.slice(Math.max(0, idx - 40), idx + 200).replace(/\s+/g, ' ').trim();
            return { errorType: pattern.type, errorContext: ctx };
        }
    }
    return { errorType: null, errorContext: '' };
}

/** 抓取页面快照(状态机输入)。 */
export function snapshotFn(): {
    url: string;
    title: string;
    text: string;
    inputs: Array<{ type: string; name?: string; placeholder?: string; id?: string; visible: boolean }>;
    buttonLabels: string[];
    hasCfChallenge: boolean;
    errorType: SnapshotErrorType;
    errorContext: string;
    capturedAt: number;
} {
    const inputs = Array.from(document.querySelectorAll('input')).map((i) => ({
        type: i.type || 'text',
        name: i.name || undefined,
        placeholder: i.placeholder || undefined,
        id: i.id || undefined,
        visible: !!(i.offsetWidth || i.offsetHeight || i.getClientRects().length),
    }));
    const buttonLabels = Array.from(document.querySelectorAll('button,[role="button"]'))
        .map((b) => (b.textContent || '').trim())
        .filter(Boolean);
    const title = document.title || '';
    const rawText = (document.body && document.body.innerText) || '';

    // 在截断前做错误扫描(完整文本上)
    const { errorType, errorContext } = scanError(`${title} ${rawText}`);

    const text = rawText.slice(0, MAX_TEXT_LENGTH);

    const hasCfChallenge =
        errorType === null &&
        /just a moment|checking your browser|请稍候|turnstile|challenge-form|verify you are human|press and hold/i.test(
            `${title} ${text}`,
        );

    return {
        url: location.href,
        title,
        text,
        inputs,
        buttonLabels,
        hasCfChallenge,
        errorType,
        errorContext,
        capturedAt: Date.now(),
    };
}

/**
 * React 16+ _valueTracker 绕过:给 input 写值并派发 input/change/blur 事件。
 * 迁移自现有 browserService 的 forceReactInput。
 */
export function setReactInputFn(element: HTMLInputElement, value: string): boolean {
    element.focus();
    if (element.select) element.select();
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, value);
    } catch {
        ok = false;
    }
    if (!ok) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (!nativeSetter) {
            element.value = value;
            return false;
        }
        nativeSetter.call(element, '');
        let tracker = (element as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
        if (tracker) tracker.setValue('dummy');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        nativeSetter.call(element, value);
        tracker = (element as unknown as { _valueTracker?: { setValue: (v: string) => void } })._valueTracker;
        if (tracker) tracker.setValue('');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    return true;
}

export interface ClickTargetProbeOptions {
    readonly text: string;
    readonly selector?: string;
    readonly exact?: boolean;
}

export type ClickTargetProbeResult =
    | {
          readonly ok: true;
          readonly x: number;
          readonly y: number;
          readonly label: string;
          readonly selectorUsed: string;
      }
    | {
          readonly ok: false;
          readonly reason: 'not_found' | 'not_visible' | 'disabled' | 'covered';
          readonly detail: string;
          readonly candidates: readonly string[];
      };

function isElementVisible(el: Element): boolean {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0
    );
}

function elementLabel(el: Element): string {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = el.getAttribute('aria-label') || '';
    const value = (el as HTMLInputElement).value || '';
    return text || aria || value || el.getAttribute('name') || el.getAttribute('id') || el.tagName.toLowerCase();
}

function matchesText(el: Element, text: string, exact?: boolean): boolean {
    const label = elementLabel(el).toLowerCase();
    const needle = text.trim().toLowerCase();
    if (!needle) return true;
    return exact ? label === needle : label.includes(needle);
}

function isDisabled(el: Element): boolean {
    const target = el as HTMLButtonElement;
    return (
        target.disabled === true ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.closest('[aria-disabled="true"],[disabled]') !== null
    );
}

/**
 * 点击目标探针:优先按 selector 找,再按可见文字回退。
 * 只返回诊断和坐标,真正点击仍由浏览器驱动产生可信鼠标事件。
 */
export function findClickTargetFn(opts: ClickTargetProbeOptions): ClickTargetProbeResult {
    const genericSelector = 'button,[role="button"],input[type="button"],input[type="submit"]';
    const selectorCandidates = opts.selector ? Array.from(document.querySelectorAll(opts.selector)) : [];
    const genericCandidates = Array.from(document.querySelectorAll(genericSelector));
    const allCandidates = [...selectorCandidates, ...genericCandidates];
    const visibleCandidates = allCandidates.filter(isElementVisible);
    const candidateLabels = visibleCandidates.slice(0, 12).map((el) => elementLabel(el));

    let target: Element | undefined;
    if (selectorCandidates.length > 0) {
        target =
            selectorCandidates.find((el) => isElementVisible(el) && matchesText(el, opts.text, opts.exact)) ??
            selectorCandidates.find(isElementVisible);
    }
    target ??= genericCandidates.find((el) => isElementVisible(el) && matchesText(el, opts.text, opts.exact));

    if (!target) {
        return {
            ok: false,
            reason: visibleCandidates.length > 0 ? 'not_found' : 'not_visible',
            detail: `selector=${opts.selector || ''}; text=${opts.text}`,
            candidates: candidateLabels,
        };
    }

    if (!isElementVisible(target)) {
        return { ok: false, reason: 'not_visible', detail: elementLabel(target), candidates: candidateLabels };
    }

    if (isDisabled(target)) {
        return { ok: false, reason: 'disabled', detail: elementLabel(target), candidates: candidateLabels };
    }

    target.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = (target as HTMLElement).getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    if (top && top !== target && !target.contains(top)) {
        return {
            ok: false,
            reason: 'covered',
            detail: `${elementLabel(target)} covered by ${elementLabel(top)} <${top.tagName.toLowerCase()}>`,
            candidates: candidateLabels,
        };
    }

    return {
        ok: true,
        x,
        y,
        label: elementLabel(target),
        selectorUsed: opts.selector || genericSelector,
    };
}

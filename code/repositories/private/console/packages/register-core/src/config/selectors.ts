import fs from 'node:fs';
import path from 'node:path';
import { bundledConfigDir } from './paths.js';

export interface RegistrationSelectorConfig {
    readonly signup: {
        readonly phoneInput: string;
        readonly phoneSubmit: string;
    };
    readonly password: {
        readonly input: string;
        readonly submit: string;
    };
    readonly aboutYou: {
        readonly nameInput: string;
        readonly birthInput?: string;
        readonly ageInput?: string;
        readonly submit: string;
    };
    readonly oauth: {
        readonly emailInput: string;
        readonly passwordInput: string;
        readonly submit: string;
    };
    readonly smsCode: {
        readonly input: string;
    };
    readonly cloudflare: {
        readonly titleHints: readonly string[];
        readonly bodyHints: readonly string[];
    };
}

type PartialDeep<T> = {
    readonly [K in keyof T]?: T[K] extends readonly string[]
        ? readonly string[]
        : T[K] extends object
            ? PartialDeep<T[K]>
            : T[K];
};

export const DEFAULT_SELECTOR_CONFIG: RegistrationSelectorConfig = {
    signup: {
        phoneInput: "input[name='phoneNumberInput'], input[type='tel'], input[name='phone']",
        phoneSubmit: "button[type='submit']",
    },
    password: {
        input: "input[type='password'], input[name='new-password'], input[name='password']",
        submit: "button[type='submit']",
    },
    aboutYou: {
        nameInput: "input[name='name'], input[name='full_name'], input[name='fullName']",
        birthInput: "input[type='date'], input[name='birthday'], input[name='birth_date']",
        ageInput: "input[name='age']",
        submit: "button[type='submit']",
    },
    oauth: {
        emailInput: "input[type='email'], input[name='email'], input[name='username'], input[name='identifier']",
        passwordInput: "input[type='password']",
        submit: "button[type='submit']",
    },
    smsCode: {
        input: "input[autocomplete='one-time-code'], input[inputmode='numeric'], input[name='code']",
    },
    cloudflare: {
        titleHints: ['just a moment', 'checking your browser', '请稍候'],
        bodyHints: ['just a moment', 'checking', 'cf-please-wait', 'turnstile', 'challenge'],
    },
};

function mergeSection<T extends Record<string, unknown>>(defaults: T, raw: Partial<T> | undefined): T {
    return { ...defaults, ...(raw ?? {}) };
}

export function normalizeSelectorConfig(raw?: PartialDeep<RegistrationSelectorConfig>): RegistrationSelectorConfig {
    return {
        signup: mergeSection(DEFAULT_SELECTOR_CONFIG.signup, raw?.signup),
        password: mergeSection(DEFAULT_SELECTOR_CONFIG.password, raw?.password),
        aboutYou: mergeSection(DEFAULT_SELECTOR_CONFIG.aboutYou, raw?.aboutYou),
        oauth: mergeSection(DEFAULT_SELECTOR_CONFIG.oauth, raw?.oauth),
        smsCode: mergeSection(DEFAULT_SELECTOR_CONFIG.smsCode, raw?.smsCode),
        cloudflare: mergeSection(DEFAULT_SELECTOR_CONFIG.cloudflare, raw?.cloudflare),
    };
}

export function loadSelectorConfig(configDir: string = bundledConfigDir): RegistrationSelectorConfig {
    const file = path.join(configDir, 'selectors.json');
    if (!fs.existsSync(file)) return DEFAULT_SELECTOR_CONFIG;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PartialDeep<RegistrationSelectorConfig>;
    return normalizeSelectorConfig(raw);
}

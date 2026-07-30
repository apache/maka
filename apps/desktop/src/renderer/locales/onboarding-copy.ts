import type { OnboardingState, UiCatalog, UiLocale } from '@maka/core';
import type { OnboardingHeroCopy, OnboardingSetupStep } from '../onboarding-hero-copy.js';

// Setup states only. `ready_empty` and `ready_with_history` render no hero
// (#1433): a configured user lands on the normal empty chat.
type VisibleOnboardingKind = Exclude<OnboardingState['kind'], 'ready_with_history' | 'ready_empty'>;

export interface OnboardingCatalog {
  hero: Record<VisibleOnboardingKind, Omit<OnboardingHeroCopy, 'kind' | 'connectionSlug'>>;
  setupSteps: Record<VisibleOnboardingKind, readonly OnboardingSetupStep[]>;
  setupProgressLabel: string;
  setupStatus: Record<OnboardingSetupStep['state'], string>;
  needsConnection: {
    subtitle: string;
    pickLabel: string;
    pickHint: string;
    browseProviders: string;
  };
  refresh: {
    pending: string;
    connection: string;
    credentials: string;
    model: string;
    blocked: string;
  };
  connectionLabel: string;
  skip: string;
  skipping: string;
  snapshotErrorFallback: string;
}

const ONBOARDING_COPY_BY_LOCALE: UiCatalog<OnboardingCatalog> = {
  zh: {
    hero: {
      needs_connection: {
        eyebrow: '欢迎使用 Maka',
        title: '不只是聊天，搞定真事。',
        body: '本地运行、走你自己的 API key、对每一步可见可控。点常见接入卡片进入「设置 · 模型」添加它的 key。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_default_connection: {
        eyebrow: '选择默认模型连接',
        title: '选一个连接作为默认。',
        body: '你已经配置了至少一个模型连接，但还没设为默认。请到「设置 · 模型」挑一个作为默认连接，再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_connection_credentials: {
        eyebrow: '补齐凭据',
        title: '为这个连接配置 API key。',
        body: '默认连接等待填写 API key。请到「设置 · 模型」打开该连接，补齐密钥后再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      needs_default_model: {
        eyebrow: '选择默认模型',
        title: '为这个连接选一个可用模型。',
        body: '默认连接还没绑定可用模型。请到「设置 · 模型」给它选一个，再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      },
      blocked: {
        eyebrow: '等待恢复模型连接',
        title: '当前没有通过验证的模型连接。',
        body: '请到「设置 · 模型」查看每个连接的状态，重新测试或重新登录后再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
        tone: 'destructive',
      },
    },
    setupSteps: {
      needs_connection: [
        { label: '选择 AI 接入', detail: '从 Claude、OpenAI、GLM、本地 Ollama 等连接开始。', state: 'active' },
        { label: '补齐认证', detail: '使用 API key 或已接入的 OAuth 登录，不写入聊天记录。', state: 'pending' },
        { label: '测试并设默认', detail: '拉取模型、通过测试，再回到这里开始第一条对话。', state: 'pending' },
      ],
      needs_default_connection: [
        { label: '已有可用连接', detail: '至少一个真实模型连接已经通过基础检查。', state: 'done' },
        { label: '设为默认', detail: '选择新会话默认使用的连接，避免发送时猜测。', state: 'active' },
        { label: '开始对话', detail: '默认连接生效后，这一屏会让位给下方的消息输入框。', state: 'pending' },
      ],
      needs_connection_credentials: [
        { label: '连接已选定', detail: '默认连接已定位，接下来只处理认证。', state: 'done' },
        { label: '补齐认证', detail: '填写 API key 或完成对应账号登录。', state: 'active' },
        { label: '测试并设默认模型', detail: '测试通过后再选择可用于聊天的模型。', state: 'pending' },
      ],
      needs_default_model: [
        { label: '认证已就绪', detail: '连接已经能访问供应商，下一步是模型选择。', state: 'done' },
        { label: '选择聊天模型', detail: '从实时模型列表里选一个可发送对话的模型。', state: 'active' },
        { label: '刷新检测', detail: '保存后回到这里刷新，Maka 会把这一屏换成消息输入框。', state: 'pending' },
      ],
      blocked: [
        { label: '连接测试失败', detail: '现有真实连接都还不能稳定发送。', state: 'warning' },
        { label: '修复认证或网络', detail: '重新登录、更新 key，或检查代理 / 供应商状态。', state: 'active' },
        { label: '重新测试', detail: '测试通过后再继续首条对话。', state: 'pending' },
      ],
    },
    setupProgressLabel: '配置 AI 进度',
    setupStatus: { done: '已完成', active: '当前步骤', pending: '待完成', warning: '需要处理' },
    needsConnection: {
      subtitle: '本地运行 · 自带 key · 每一步可见可控',
      pickLabel: '选择你的 AI',
      pickHint: '点一个进入设置，填它的 key',
      browseProviders: '浏览全部服务商',
    },
    refresh: {
      pending: '刷新中…',
      connection: '已经设好了？刷新检测',
      credentials: '已经填好了？刷新检测',
      model: '已经选好了？刷新检测',
      blocked: '已经修好了？刷新检测',
    },
    connectionLabel: '连接',
    skip: '跳过，先逛逛',
    skipping: '跳过中…',
    snapshotErrorFallback: '首次使用状态暂时不可用，请稍后重试。',
  },
  en: {
    hero: {
      needs_connection: {
        eyebrow: 'Welcome to Maka',
        title: 'Go beyond chat. Get real work done.',
        body: 'Run locally, bring your own API key, and keep every step visible and controllable. Choose a provider to add its key in Settings · Models.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_default_connection: {
        eyebrow: 'Choose a default model connection',
        title: 'Choose a connection as the default.',
        body: 'At least one model connection is configured, but none is the default. Choose one in Settings · Models before starting a conversation.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_connection_credentials: {
        eyebrow: 'Add credentials',
        title: 'This connection still needs an API key.',
        body: 'The default connection has no usable credentials. Open it in Settings · Models and add its API key before starting a conversation.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      needs_default_model: {
        eyebrow: 'Choose a default model',
        title: 'This connection has no default model.',
        body: 'The connection is ready, but it has no model selected for conversations. Choose one in Settings · Models.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
      },
      blocked: {
        eyebrow: 'Restore a model connection',
        title: 'No model connection is currently verified.',
        body: 'Open Settings · Models to inspect each connection, then retest or sign in again before starting a conversation.',
        cta: { label: 'Open Settings · Models', settingsSection: 'models' },
        tone: 'destructive',
      },
    },
    setupSteps: {
      needs_connection: [
        { label: 'Choose an AI provider', detail: 'Start with Claude, OpenAI, GLM, local Ollama, or another connection.', state: 'active' },
        { label: 'Add authentication', detail: 'Use an API key or supported OAuth login. Credentials are not written to chat history.', state: 'pending' },
        { label: 'Test and set default', detail: 'Load models, pass the connection test, then return for your first conversation.', state: 'pending' },
      ],
      needs_default_connection: [
        { label: 'Connection available', detail: 'At least one real model connection passed its basic checks.', state: 'done' },
        { label: 'Set as default', detail: 'Choose the connection new sessions use by default.', state: 'active' },
        { label: 'Start a conversation', detail: 'Once saved, this screen gives way to the message input below.', state: 'pending' },
      ],
      needs_connection_credentials: [
        { label: 'Connection selected', detail: 'The default connection is known; only authentication remains.', state: 'done' },
        { label: 'Add authentication', detail: 'Enter an API key or finish the matching account login.', state: 'active' },
        { label: 'Test and choose a model', detail: 'After the test passes, choose a model that can handle chat.', state: 'pending' },
      ],
      needs_default_model: [
        { label: 'Authentication ready', detail: 'The provider is reachable; the next step is model selection.', state: 'done' },
        { label: 'Choose a chat model', detail: 'Select a conversation-capable model from the live model list.', state: 'active' },
        { label: 'Refresh status', detail: 'Save, return here, and Maka will swap this screen for the message input.', state: 'pending' },
      ],
      blocked: [
        { label: 'Connection tests failed', detail: 'None of the configured connections can send reliably yet.', state: 'warning' },
        { label: 'Fix authentication or network', detail: 'Sign in again, update the key, or check the proxy and provider status.', state: 'active' },
        { label: 'Test again', detail: 'Continue to the first conversation after a test passes.', state: 'pending' },
      ],
    },
    setupProgressLabel: 'AI setup progress',
    setupStatus: { done: 'Completed', active: 'Current step', pending: 'Pending', warning: 'Needs attention' },
    needsConnection: {
      subtitle: 'Local runtime · Your own key · Every step visible and controllable',
      pickLabel: 'Choose your AI',
      pickHint: 'Choose one to open Settings and add its key',
      browseProviders: 'Browse all providers',
    },
    refresh: {
      pending: 'Refreshing…',
      connection: 'Already set it? Refresh status',
      credentials: 'Already added it? Refresh status',
      model: 'Already selected one? Refresh status',
      blocked: 'Already fixed it? Refresh status',
    },
    connectionLabel: 'Connection',
    skip: 'Skip and explore',
    skipping: 'Skipping…',
    snapshotErrorFallback: 'First-run status is temporarily unavailable. Try again later.',
  },
};

export function getOnboardingCopy(locale: UiLocale): OnboardingCatalog {
  return ONBOARDING_COPY_BY_LOCALE[locale];
}

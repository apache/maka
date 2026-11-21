// 真实模型工厂：沿用旧 llm.py 的环境变量与 provider 表，产出 ChatOpenAI（OpenAI 兼容协议）。
// 技术验证（spike3）：ChatOpenAI 容忍空 choices 帧、把 deepseek 的 reasoning_content 放进
// additional_kwargs.reasoning_content、HTTP 500 抛 status=500 的错误——翻译层都已覆盖。
import { ChatOpenAI } from '@langchain/openai';

const BASE_URL: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.cn/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
};
const DEFAULT_MODEL: Record<string, string> = { deepseek: 'deepseek-chat', kimi: 'moonshot-v1-8k', glm: 'glm-4-flash', openai: 'gpt-4o-mini' };

export function createChatModel(env = process.env) {
  const provider = (env.OPENAI_PROVIDER ?? 'openai').toLowerCase();
  return new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL ?? DEFAULT_MODEL[provider] ?? 'gpt-4o-mini',
    configuration: { baseURL: env.OPENAI_BASE_URL ?? BASE_URL[provider] ?? BASE_URL.openai },
    temperature: 0.3,
    streaming: true,
    streamUsage: true,
    maxRetries: 1, // 重试交给 modelRetryMiddleware 统一管（WP7 决定是否启用）
    timeout: 60_000,
  });
}

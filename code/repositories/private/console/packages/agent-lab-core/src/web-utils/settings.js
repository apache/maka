// src/utils/settings.js
// 设置的存取与连接测试（纯逻辑，无 DOM）——表单在 app/components/SettingsDialog.jsx。
//
// 浏览器版用它替代 nano-pi 的环境变量（NANOPI_API_KEY / NANOPI_MODEL / …）。
// key 只存 localStorage（本机浏览器），不会发给 baseUrl 以外的任何地方。

const STORAGE_KEY = 'pi-web-dev:settings'

/** 默认 system prompt：告诉模型自己活在虚拟沙盒里、文件有哪些、怎么验证 */
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个运行在浏览器虚拟沙盒里的编码助手。用提供的工具读写虚拟文件、执行 JS 来完成任务。' +
  '虚拟根目录下有：README.md、math.js、test.js。先阅读再修改，修改后用 run_js 执行 test.js 验证。'

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  // compaction 配置（期6）：默认与 pi-from-scratch 的 TS 版一致；
  // 演示时可调低（如 8/4），眼看消息流超过阈值触发压缩
  compactThreshold: 50,
  keepRecent: 20,
}

/** 读取设置：localStorage 覆盖默认值（缺字段用默认，坏 JSON 回落默认） */
export function getSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return { ...DEFAULTS, ...saved }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 保存设置（表单提交时调用） */
export function saveSettings(s) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

/** 表单值归一：空值/非法值回默认（阈值 ≤2 或保留数 ≤0 视为没填好） */
export function normalizeSettings(raw) {
  return {
    baseUrl: String(raw.baseUrl ?? '').trim() || DEFAULTS.baseUrl,
    apiKey: String(raw.apiKey ?? '').trim(),
    model: String(raw.model ?? '').trim() || DEFAULTS.model,
    systemPrompt: String(raw.systemPrompt ?? '') || DEFAULT_SYSTEM_PROMPT,
    compactThreshold: Number(raw.compactThreshold) > 2 ? Number(raw.compactThreshold) : DEFAULTS.compactThreshold,
    keepRecent: Number(raw.keepRecent) > 0 ? Number(raw.keepRecent) : DEFAULTS.keepRecent,
  }
}

/**
 * 测试连接：非流式 1-token 请求，验证 URL、key、模型名和 CORS——
 * 浏览器直连要求端点允许跨域，OpenAI / OpenRouter 等支持；部分中转站不支持。
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testConnection(s) {
  if (!s.apiKey) return { ok: false, message: '✗ 请先填写 API Key' }
  try {
    const res = await fetch(`${s.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    })
    if (res.ok) return { ok: true, message: '✓ 连接成功，可以保存并开始使用了' }
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      message: `✗ API ${res.status}：${text.slice(0, 200)}（401 = key 无效；404 = baseUrl/模型名可能不对）`,
    }
  } catch (e) {
    return {
      ok: false,
      message: `✗ ${e.message}——常见原因：URL 写错、断网，或该端点不允许浏览器跨域（CORS）。可换 OpenAI / OpenRouter 等支持 CORS 的端点`,
    }
  }
}

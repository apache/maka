// 各 Agent 的配置写入预览。字段名以各工具当前文档为准，WP7 实现前逐一用真实 CLI 验证（05-风险 R4）。
export function configPreview(agentId: string, model: string, addr: string): { path: string; lang: string; body: string } {
  const base = `http://${addr}`;
  if (agentId === "claude-code")
    return {
      path: "~/.claude/settings.json（只改 env 下 3 个键，其余原样保留）",
      lang: "json",
      body: JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "qpa_cc_••••••", ANTHROPIC_MODEL: model } }, null, 2),
    };
  if (agentId === "codex")
    return {
      path: "~/.codex/config.toml（只增改 model / model_provider 与一个 [model_providers] 表）",
      lang: "toml",
      body: [
        `model = "${model}"`,
        `model_provider = "qoder-proxy"`,
        ``,
        `[model_providers.qoder-proxy]`,
        `name = "qoder-proxy-api"`,
        `base_url = "${base}/v1"`,
        `env_key = "QPA_CODEX_KEY"`,
        `wire_api = "responses"`,
      ].join("\n"),
    };
  return {
    path: "~/.config/opencode/opencode.json（只增改 provider.qoder-proxy 与 model）",
    lang: "json",
    body: JSON.stringify(
      {
        provider: { "qoder-proxy": { npm: "@ai-sdk/openai-compatible", name: "qoder-proxy-api", options: { baseURL: `${base}/v1`, apiKey: "{env:QPA_OPENCODE_KEY}" }, models: { [model]: {} } } },
        model: `qoder-proxy/${model}`,
      },
      null,
      2,
    ),
  };
}

import { useState } from "react";
import { toast } from "sonner";
import { PlugZap, Plus, Trash2 } from "lucide-react";
import { Badge } from "@ig/components/ui/badge";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent } from "@ig/components/ui/card";
import { Input } from "@ig/components/ui/input";
import { testProvider } from "@ig/features/interviewer/lib/providers";
import { presetToConfig, PROVIDER_PRESETS } from "@ig/features/interviewer/lib/presets";
import type { ProviderConfig } from "@ig/state/store";
import { useArena } from "@ig/state/store";

// BYOK 服务商管理：增删改 + 连接测试；Key 只存 localStorage
export function ProviderManager() {
  const providers = useArena((s) => s.providers);
  const defaultProviderId = useArena((s) => s.defaultProviderId);
  const upsertProvider = useArena((s) => s.upsertProvider);
  const removeProvider = useArena((s) => s.removeProvider);
  const setDefaultProvider = useArena((s) => s.setDefaultProvider);
  const [testing, setTesting] = useState<string | null>(null);

  async function test(cfg: ProviderConfig) {
    setTesting(cfg.id);
    try {
      const reply = await testProvider(cfg);
      toast.success(`「${cfg.label}」连通：${reply}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">AI 服务商（BYOK）</h2>
        <p className="text-xs text-muted-foreground">
          Key 保存在浏览器 localStorage。默认由浏览器直连；被 CORS
          挡住的厂商可勾「走本地中继」，请求和 Key 会经当前应用的服务端转发。
        </p>
      </div>

      {providers.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有服务商，从下面的预设添加一个。</p>
      )}

      {providers.map((cfg) => (
        <Card key={cfg.id}>
          <CardContent className="space-y-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={cfg.label}
                onChange={(e) => upsertProvider({ ...cfg, label: e.target.value })}
                className="w-36"
                aria-label="名称"
              />
              <Badge variant="outline">
                {cfg.kind === "anthropic" ? "Anthropic" : "OpenAI 兼容"}
              </Badge>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="radio"
                  name="default-provider"
                  checked={defaultProviderId === cfg.id}
                  onChange={() => setDefaultProvider(cfg.id)}
                  className="accent-primary"
                />
                默认
              </label>
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => test(cfg)}
                disabled={testing === cfg.id}
              >
                <PlugZap className="size-4" /> {testing === cfg.id ? "测试中…" : "测试连接"}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="删除服务商"
                onClick={() => {
                  removeProvider(cfg.id);
                  toast.success(`已删除「${cfg.label}」`);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <LabeledField label="Base URL">
                <Input
                  value={cfg.baseUrl}
                  onChange={(e) => upsertProvider({ ...cfg, baseUrl: e.target.value })}
                />
              </LabeledField>
              <LabeledField label="模型">
                <Input
                  value={cfg.model}
                  onChange={(e) => upsertProvider({ ...cfg, model: e.target.value })}
                />
              </LabeledField>
              <LabeledField label="API Key">
                <Input
                  type="password"
                  value={cfg.apiKey}
                  onChange={(e) => upsertProvider({ ...cfg, apiKey: e.target.value })}
                  placeholder="sk-…"
                />
              </LabeledField>
              <label className="flex items-end gap-2 pb-1 text-sm">
                <input
                  type="checkbox"
                  checked={cfg.viaProxy}
                  onChange={(e) => upsertProvider({ ...cfg, viaProxy: e.target.checked })}
                  className="accent-primary"
                />
                走本地中继（当前应用）
              </label>
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="flex flex-wrap gap-1.5">
        {PROVIDER_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="sm"
            onClick={() => {
              upsertProvider(presetToConfig(preset));
              toast.success(`已添加「${preset.label}」预设，填上 Key 即可测试`);
            }}
          >
            <Plus className="size-4" /> {preset.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

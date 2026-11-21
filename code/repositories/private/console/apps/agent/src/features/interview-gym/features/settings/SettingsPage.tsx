import { useRef } from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { Button } from "@ig/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ig/components/ui/card";
import { Input } from "@ig/components/ui/input";
import { localDateKey } from "@ig/lib/dates";
import { DEFAULT_CONFIG } from "@ig/state/session";
import type { SessionConfig } from "@ig/state/session";
import { useArena } from "@ig/state/store";
import type { ThemeMode } from "@ig/state/store";
import { ProviderManager } from "@ig/features/interviewer/components/ProviderManager";
import { BackLink } from "@ig/features/practice/components/Runner";

const THEME_OPTIONS: Array<{ key: ThemeMode; label: string }> = [
  { key: "dark", label: "深色（默认）" },
  { key: "light", label: "浅色" },
  { key: "system", label: "跟随系统" },
];

const CONFIG_FIELDS: Array<{ key: keyof SessionConfig; label: string; max: number }> = [
  { key: "p0p1", label: "P0 / P1 基础题", max: 20 },
  { key: "ai", label: "AI / Agent 追问", max: 20 },
  { key: "design", label: "系统设计", max: 5 },
  { key: "project", label: "项目口述", max: 5 },
  { key: "retest", label: "卡点复测上限", max: 10 },
];

export default function SettingsPage() {
  const theme = useArena((s) => s.theme);
  const setTheme = useArena((s) => s.setTheme);
  const config = useArena((s) => s.config);
  const setConfig = useArena((s) => s.setConfig);
  const interviewRounds = useArena((s) => s.interviewRounds);
  const setInterviewRounds = useArena((s) => s.setInterviewRounds);
  const importData = useArena((s) => s.importData);
  const clearAll = useArena((s) => s.clearAll);
  const fileRef = useRef<HTMLInputElement>(null);

  function exportAll() {
    const state = useArena.getState();
    const payload = {
      exportedAt: new Date().toISOString(),
      attempts: state.attempts,
      config: state.config,
      bookmarks: state.bookmarks,
      notes: state.notes,
      providers: state.providers,
      defaultProviderId: state.defaultProviderId,
      interviewRounds: state.interviewRounds,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `自练场备份-${localDateKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已导出全部数据（含模型配置，注意保管）");
  }

  async function importAll(file: File) {
    try {
      const data = JSON.parse(await file.text());
      importData(data);
      toast.success("数据已导入");
    } catch {
      toast.error("导入失败：备份 JSON 无效或字段格式不正确");
    }
  }

  return (
    <div className="space-y-4">
      <BackLink to="/" label="仪表盘" />
      <h1 className="text-lg font-semibold">设置</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">外观</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-1">
          {THEME_OPTIONS.map((opt) => (
            <Button
              key={opt.key}
              variant={theme === opt.key ? "default" : "ghost"}
              size="sm"
              onClick={() => setTheme(opt.key)}
            >
              {opt.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">每日配比</CardTitle>
          <CardDescription>
            来自《十月冲刺计划》，改完第二天生效（当天已生成的会话不变）
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {CONFIG_FIELDS.map(({ key, label, max }) => (
            <label key={key} className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <Input
                type="number"
                min={0}
                max={max}
                value={config[key]}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(max, Number(e.target.value) || 0));
                  setConfig({ ...config, [key]: n });
                }}
                className="w-20"
              />
            </label>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => setConfig(DEFAULT_CONFIG)}
          >
            恢复默认配比
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">AI 面试官</CardTitle>
          <CardDescription>每题的追问轮数（1–5），评分口径固定为四维 0–2</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 text-sm">
            追问轮数
            <Input
              type="number"
              min={1}
              max={5}
              value={interviewRounds}
              onChange={(e) =>
                setInterviewRounds(Math.max(1, Math.min(5, Number(e.target.value) || 3)))
              }
              className="w-20"
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <ProviderManager />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">数据管理</CardTitle>
          <CardDescription>
            练习数据、笔记与模型配置都在本机浏览器；换设备用备份迁移
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportAll}>
            <Download className="size-4" /> 导出全部数据
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> 导入备份
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importAll(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            onClick={() => {
              if (confirm("清空全部练习数据？此操作不可撤销（建议先导出）。")) {
                clearAll();
                toast.success("已清空练习数据");
              }
            }}
          >
            清空练习数据
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

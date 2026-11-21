'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { useBatches, useImportErrors, useImportOriginal, useImportReauth } from '@/lib/assets/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ggbdpq/console-ui';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ggbdpq/console-ui';
import { Button } from '@ggbdpq/console-ui';
import { Textarea } from '@ggbdpq/console-ui';
import { Label } from '@ggbdpq/console-ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ggbdpq/console-ui';

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

function FilePick({ onText }: { onText: (text: string, name: string) => void }) {
  return (
    <input
      type="file"
      accept=".json,.jsonl,.txt"
      className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-accent"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        void readFile(f).then((t) => {
          onText(t, f.name);
          toast.success(`已读取 ${f.name}`);
        });
        e.target.value = '';
      }}
    />
  );
}

export default function ImportPage() {
  const { data: batches } = useBatches();
  const importOriginal = useImportOriginal();
  const importReauth = useImportReauth();
  const importErrors = useImportErrors();

  const [originalText, setOriginalText] = useState('');
  const [originalName, setOriginalName] = useState('');
  const [batchId, setBatchId] = useState('none');

  const [reauthText, setReauthText] = useState('');
  const [reauthName, setReauthName] = useState('');

  const [errorText, setErrorText] = useState('');
  const [errorEmails, setErrorEmails] = useState('');

  // 批量模式：邮箱列表 → 账号 ID

  const submitErrors = async () => {
    let accountIds: number[] | undefined;
    const emails = errorEmails.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (emails.length) {
      const ids: number[] = [];
      for (const em of emails) {
        const res = await fetch(`/api/accounts?email=${encodeURIComponent(em)}`).then((r) => r.json());
        const hit = (res.rows ?? []).find((a: { email: string }) => a.email === em.toLowerCase());
        if (hit) ids.push(hit.id);
      }
      if (ids.length === 0) {
        toast.error('邮箱列表中的账号都不在系统里');
        return;
      }
      accountIds = ids;
    }
    importErrors.mutate(
      { text: errorText, accountIds },
      {
        onSuccess: (r) =>
          toast.success(`应用 ${r.applied} 条`, {
            description: [
              r.unmatched.length ? `未匹配：${r.unmatched.join('、')}` : null,
              r.unrecognized ? `${r.unrecognized} 行无法识别报错类型` : null,
            ]
              .filter(Boolean)
              .join('；') || undefined,
          }),
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">导入中心</h1>
      <Tabs defaultValue="original">
        <TabsList>
          <TabsTrigger value="original">原始卡密 JSONL</TabsTrigger>
          <TabsTrigger value="reauth">OA 授权结果</TabsTrigger>
          <TabsTrigger value="errors">报错粘贴</TabsTrigger>
        </TabsList>

        <TabsContent value="original">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">导入原始卡密</CardTitle>
              <CardDescription>支持 JSONL / TXT（每行一个账号 JSON），新账号状态=正常、额度=100</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <FilePick onText={(t, n) => { setOriginalText(t); setOriginalName(n); }} />
                <Select value={batchId} onValueChange={setBatchId}>
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="不关联批次" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不关联批次</SelectItem>
                    {batches?.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.card_code ?? b.folder_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Textarea
                rows={10}
                placeholder="也可以直接粘贴 JSONL 文本…"
                value={originalText}
                onChange={(e) => setOriginalText(e.target.value)}
              />
              <Button
                disabled={!originalText.trim() || importOriginal.isPending}
                onClick={() =>
                  importOriginal.mutate(
                    {
                      text: originalText,
                      batchId: batchId === 'none' ? undefined : Number(batchId),
                      fileName: originalName || undefined,
                    },
                    {
                      onSuccess: (r) =>
                        toast.success(`解析 ${r.parsed} 条：新建 ${r.created}，更新 ${r.updated}`),
                      onError: (e) => toast.error(e.message),
                    },
                  )
                }
              >
                导入
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reauth">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">导入 OA 授权结果</CardTitle>
              <CardDescription>
                按邮箱自动匹配合并：更新 token、写入 reauth_at、按规则计算一个月后过期日、额度重置 100、状态归位正常
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <FilePick onText={(t, n) => { setReauthText(t); setReauthName(n); }} />
              <Textarea
                rows={10}
                placeholder="粘贴 oauth_success JSONL…"
                value={reauthText}
                onChange={(e) => setReauthText(e.target.value)}
              />
              <Button
                disabled={!reauthText.trim() || importReauth.isPending}
                onClick={() =>
                  importReauth.mutate(
                    { text: reauthText, fileName: reauthName || undefined },
                    {
                      onSuccess: (r) =>
                        toast.success(`合并 ${r.applied} 个账号`, {
                          description: r.unmatched.length
                            ? `未匹配 ${r.unmatched.length} 个：${r.unmatched.slice(0, 5).join('、')}${r.unmatched.length > 5 ? '…' : ''}`
                            : undefined,
                        }),
                      onError: (e) => toast.error(e.message),
                    },
                  )
                }
              >
                合并授权结果
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="errors">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">报错粘贴 → 自动归类</CardTitle>
              <CardDescription>
                行内带邮箱的报错自动归属账号；无邮箱的报错行配合下方邮箱列表批量套用。支持 401 过期 / 401 失效 / 401
                无效凭据 / 402 K12 / 429 限流五类
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label>报错日志</Label>
                <Textarea
                  rows={8}
                  placeholder={'len.begnaud@outlook.com 额度获取失败：401 Provided authentication token is expired…\n402 {"detail":{"code":"deactivated_workspace"}}'}
                  value={errorText}
                  onChange={(e) => setErrorText(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>适用账号邮箱（可选，每行一个；仅当报错行没有邮箱时批量套用）</Label>
                <Textarea
                  rows={4}
                  placeholder="a@outlook.com&#10;b@outlook.com"
                  value={errorEmails}
                  onChange={(e) => setErrorEmails(e.target.value)}
                />
              </div>
              <Button disabled={!errorText.trim() || importErrors.isPending} onClick={() => void submitErrors()}>
                解析并应用
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

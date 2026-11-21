'use client';

// 工具集：registration-toolkit 去重后的独有内容——K12 workspace 批量加组的数据视图 +
// outlook007 批量注册产物。批量动作走 CLI（`pnpm cli -- toolkit batch-email --creds <file>`）。

import { useQuery } from "@tanstack/react-query";
import { Card, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Button } from "@ggbdpq/console-ui";

interface Overview {
  accountsTotal: number;
  accountsDisabled: number;
  hasWorkspaces: boolean;
  batchRuns: Array<{ date: string; success: number; failed: number; total: number }>;
}

interface AccountRow {
  file: string;
  email: string;
  accountId: string;
  planType: string;
  expired: string | null;
  lastRefresh: string | null;
  disabled: boolean;
  mtime: string;
}

interface WorkspacesPayload {
  workspaces: Record<string, unknown> | null;
  idsText: string | null;
  mailLists: Array<{ file: string; content: string }>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tnum mt-1 text-2xl font-semibold">{value}</p>
    </Card>
  );
}

export default function ToolkitPage() {
  const overview = useQuery({ queryKey: ["toolkit-overview"], queryFn: () => getJson<{ overview: Overview }>("/api/toolkit/overview") });
  const accounts = useQuery({ queryKey: ["toolkit-accounts"], queryFn: () => getJson<{ accounts: AccountRow[] }>("/api/toolkit/accounts") });
  const workspaces = useQuery({ queryKey: ["toolkit-workspaces"], queryFn: () => getJson<WorkspacesPayload>("/api/toolkit/workspaces") });

  const o = overview.data?.overview;

  return (
    <section className="mx-auto max-w-[1720px] space-y-4 px-6 py-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">工具集</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            registration-toolkit 去重后的独有内容：K12 workspace 批量加组数据与 outlook007 批量注册产物。
            批量注册走 CLI（<code className="rounded bg-muted px-1">pnpm cli -- toolkit batch-email --creds &lt;file&gt;</code>，
            需环境变量 <code className="rounded bg-muted px-1">OUTLOOK007_API_KEY</code>）。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { overview.refetch(); accounts.refetch(); workspaces.refetch(); }}>刷新</Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="K12 账号数" value={o?.accountsTotal ?? "—"} />
        <Stat label="已停用" value={o?.accountsDisabled ?? "—"} />
        <Stat label="Workspace SSOT" value={o?.hasWorkspaces ? "已配置" : "缺失"} />
      </div>

      <Tabs defaultValue="accounts">
        <TabsList>
          <TabsTrigger value="accounts">K12 账号</TabsTrigger>
          <TabsTrigger value="workspaces">Workspace</TabsTrigger>
          <TabsTrigger value="batch">批量注册产物</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邮箱</TableHead>
                  <TableHead>Account ID</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>最近刷新</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(accounts.data?.accounts ?? []).map((a) => (
                  <TableRow key={a.file}>
                    <TableCell className="font-mono text-sm">{a.email}</TableCell>
                    <TableCell className="font-mono text-xs">{a.accountId || "—"}</TableCell>
                    <TableCell>{a.planType || "—"}</TableCell>
                    <TableCell className="tnum text-sm">{a.expired?.slice(0, 19) ?? "—"}</TableCell>
                    <TableCell className="tnum text-sm text-muted-foreground">{a.lastRefresh?.slice(0, 19) ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={a.disabled ? "destructive" : "default"}>{a.disabled ? "停用" : "在用"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {!accounts.data?.accounts.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">暂无账号数据（apps/console/data/toolkit/accounts/）</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="workspaces" className="space-y-4">
          <Card className="p-4">
            <p className="text-sm font-medium">workspaces.json（SSOT）</p>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-xs leading-5">
              {workspaces.data?.workspaces ? JSON.stringify(workspaces.data.workspaces, null, 2) : "缺失"}
            </pre>
          </Card>
          <Card className="p-4">
            <p className="text-sm font-medium">workspace-ids.txt</p>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs leading-5">
              {workspaces.data?.idsText ?? "缺失"}
            </pre>
          </Card>
          {(workspaces.data?.mailLists ?? []).map((m) => (
            <Card key={m.file} className="p-4">
              <p className="text-sm font-medium">mail-lists/{m.file}（{m.content.split("\n").length} 行）</p>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs leading-5">{m.content}</pre>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="batch">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>批次日期</TableHead>
                  <TableHead>成功</TableHead>
                  <TableHead>失败</TableHead>
                  <TableHead>总数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(o?.batchRuns ?? []).map((r) => (
                  <TableRow key={r.date}>
                    <TableCell className="tnum">{r.date}</TableCell>
                    <TableCell className="tnum text-success">{r.success}</TableCell>
                    <TableCell className="tnum text-destructive">{r.failed}</TableCell>
                    <TableCell className="tnum">{r.total}</TableCell>
                  </TableRow>
                ))}
                {!o?.batchRuns.length ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                      暂无批量产物（CLI toolkit batch-email 的输出落 apps/console/data/toolkit/output/）
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  );
}

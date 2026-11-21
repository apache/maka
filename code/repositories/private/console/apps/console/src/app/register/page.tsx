'use client';

// 注册台：gpt-free-register（@ggbdpq/register-core）数据只读视图。
// 账号 / token / 运行报告来自 CLI `register` 命令写入的 apps/console/data/register/app.db。
// 执行注册仍走 CLI（`pnpm cli -- register run <count>`），本页只负责看。

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger, Button } from "@ggbdpq/console-ui";

interface Overview {
  dbExists: boolean;
  accountsTotal: number;
  accountsOauthDone: number;
  tokensTotal: number;
  runsTotal: number;
  runsSuccess: number;
  latestRunAt: string | null;
}

interface AccountRow {
  id: number;
  phone: string;
  fullName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface TokenRow {
  id: number;
  email: string;
  accountId: string;
  expiredAt: string | null;
  createdAt: string;
}

interface RunRow {
  runId: string;
  mode: string;
  status: string;
  accountPhone: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  phasesReached: string | null;
}

const STATUS_TONE: Record<string, string> = {
  registered: "bg-secondary",
  email_bound: "bg-info text-info-foreground",
  oauth_done: "bg-success text-success-foreground",
  password_incorrect: "bg-warning text-warning-foreground",
  registration_failed: "bg-destructive text-destructive-foreground",
};

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

export default function RegisterPage() {
  const [tab, setTab] = useState("overview");

  const overview = useQuery({ queryKey: ["register-overview"], queryFn: () => getJson<{ overview: Overview }>("/api/register/overview") });
  const accounts = useQuery({ queryKey: ["register-accounts"], queryFn: () => getJson<{ accounts: AccountRow[] }>("/api/register/accounts"), enabled: tab === "accounts" });
  const tokens = useQuery({ queryKey: ["register-tokens"], queryFn: () => getJson<{ tokens: TokenRow[]; files: Array<{ file: string; mtime: string }> }>("/api/register/tokens"), enabled: tab === "tokens" });
  const runs = useQuery({ queryKey: ["register-runs"], queryFn: () => getJson<{ runs: RunRow[] }>("/api/register/runs"), enabled: tab === "runs" });

  const o = overview.data?.overview;

  return (
    <section className="mx-auto max-w-[1720px] space-y-4 px-6 py-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">注册台</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            gpt-free-register 引擎数据视图：账号、token、运行报告。执行注册走 CLI（
            <code className="rounded bg-muted px-1">pnpm cli -- register run &lt;count&gt;</code>，自检{" "}
            <code className="rounded bg-muted px-1">register doctor</code>）。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => overview.refetch()}>刷新</Button>
      </div>

      {!o?.dbExists ? (
        <Card className="p-4 text-sm text-muted-foreground">
          数据库尚未创建（apps/console/data/register/app.db）。先在 CLI 跑一次 <code className="rounded bg-muted px-1">register doctor</code> 或{" "}
          <code className="rounded bg-muted px-1">register run</code>。
        </Card>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="accounts">账号</TabsTrigger>
          <TabsTrigger value="tokens">Token</TabsTrigger>
          <TabsTrigger value="runs">运行报告</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label="账号总数" value={o?.accountsTotal ?? "—"} />
            <Stat label="OAuth 完成" value={o?.accountsOauthDone ?? "—"} />
            <Stat label="Token 数" value={o?.tokensTotal ?? "—"} />
            <Stat label="运行总数" value={o?.runsTotal ?? "—"} />
            <Stat label="成功运行" value={o?.runsSuccess ?? "—"} />
            <Stat label="最近运行" value={o?.latestRunAt?.slice(0, 19) ?? "—"} />
          </div>
        </TabsContent>

        <TabsContent value="accounts">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>手机号</TableHead>
                  <TableHead>姓名</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(accounts.data?.accounts ?? []).map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="tnum">{a.id}</TableCell>
                    <TableCell className="font-mono text-sm">{a.phone}</TableCell>
                    <TableCell>{a.fullName}</TableCell>
                    <TableCell>
                      <Badge className={STATUS_TONE[a.status] ?? ""}>{a.status}</Badge>
                    </TableCell>
                    <TableCell className="tnum text-sm text-muted-foreground">{a.updatedAt?.slice(0, 19)}</TableCell>
                  </TableRow>
                ))}
                {!accounts.data?.accounts.length ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">暂无账号</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="tokens" className="space-y-4">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>Account ID</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tokens.data?.tokens ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="tnum">{t.id}</TableCell>
                    <TableCell className="font-mono text-sm">{t.email}</TableCell>
                    <TableCell className="font-mono text-xs">{t.accountId || "—"}</TableCell>
                    <TableCell className="tnum text-sm">{t.expiredAt?.slice(0, 19) ?? "—"}</TableCell>
                    <TableCell className="tnum text-sm text-muted-foreground">{t.createdAt?.slice(0, 19)}</TableCell>
                  </TableRow>
                ))}
                {!tokens.data?.tokens.length ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">暂无 token</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </Card>

          {tokens.data?.files.length ? (
            <Card className="p-4">
              <p className="text-sm font-medium">token 落盘文件（data/register/tokens/）</p>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {tokens.data.files.map((f) => (
                  <li key={f.file} className="flex items-center justify-between gap-4">
                    <span className="font-mono text-xs">{f.file}</span>
                    <span className="tnum text-xs">{f.mtime.slice(0, 19)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="runs">
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run ID</TableHead>
                  <TableHead>模式</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>手机号</TableHead>
                  <TableHead>阶段</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data?.runs ?? []).map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className="font-mono text-xs">{r.runId}</TableCell>
                    <TableCell>{r.mode}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "success" ? "default" : r.status === "running" ? "secondary" : "destructive"}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.accountPhone ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.phasesReached ?? "—"}</TableCell>
                    <TableCell className="tnum text-sm text-muted-foreground">{r.startedAt?.slice(0, 19)}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-destructive" title={r.errorMessage ?? ""}>{r.errorMessage ?? ""}</TableCell>
                  </TableRow>
                ))}
                {!runs.data?.runs.length ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">暂无运行记录</TableCell>
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

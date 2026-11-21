'use client';

import { useState } from 'react';
import { ModuleNav } from '@/components/ModuleNav';
import {
  Boxes,
  Database,
  Download,
  LayoutDashboard,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';
import { useScan, useSettings } from '@/lib/assets/api';
import { cn } from '@ggbdpq/console-ui';
import { Button, ThemeToggle } from '@ggbdpq/console-ui';
import { Checkbox } from '@ggbdpq/console-ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ggbdpq/console-ui';
import { Input } from '@ggbdpq/console-ui';
import { Label } from '@ggbdpq/console-ui';
import { toast } from 'sonner';

const PURCHASE_ROOT = 'E:\\开发文档\\06-卡密管理';

// 资产台分区导航。原 card-admin 侧栏在控制台壳内改为顶栏页签，功能不变。
const NAV = [
  { to: '/assets', label: '运营总览', icon: LayoutDashboard, exact: true },
  { to: '/assets/batches', label: '购买批次', icon: Boxes },
  { to: '/assets/accounts', label: '账号台账', icon: Search },
  { to: '/assets/import', label: '导入中心', icon: Upload },
  { to: '/assets/export', label: '导出中心', icon: Download },
];

export default function AssetsLayout({ children }: { children: React.ReactNode }) {
  const { data: settings } = useSettings();
  const scan = useScan();
  const purchaseRoot = settings?.scan_roots?.purchase_root || PURCHASE_ROOT;
  const cliProxyRoot = settings?.scan_roots?.cli_proxy_root || '';
  const [scanOpen, setScanOpen] = useState(false);
  const [scanRoot, setScanRoot] = useState(PURCHASE_ROOT);
  const [saveDefault, setSaveDefault] = useState(false);
  const [scanMode, setScanMode] = useState<'append' | 'reset'>('append');
  const submitScanText = scan.isPending
    ? scanMode === 'reset'
      ? '清空扫描中…'
      : '扫描中…'
    : scanMode === 'reset'
      ? '清空后扫描'
      : '扫描（追加）';

  const openScanDialog = (mode: 'append' | 'reset') => {
    setScanMode(mode);
    setScanRoot(settings?.card_root || purchaseRoot);
    setSaveDefault(false);
    setScanOpen(true);
  };

  const submitScan = () => {
    const root = scanRoot.trim();
    if (!root) {
      toast.error('请输入扫描目录');
      return;
    }
    if (scanMode === 'reset' && !window.confirm('会先清空当前账号、批次和流水记录，再按当前目录扫描。确定继续吗？')) {
      return;
    }
    scan.mutate(
      { root, saveDefault, reset: scanMode === 'reset' },
      {
        onSuccess: (r) => {
          setScanOpen(false);
          toast.success(
            `${scanMode === 'reset' ? '清空后扫描' : '扫描'}完成：${r.batchesFound} 个批次，新建 ${r.original.created}，更新 ${r.original.updated}，授权合并 ${r.reauth.applied}`,
            { description: r.errors.length ? `${r.errors.length} 个文件读取失败` : undefined },
          );
        },
        onError: (e) => toast.error(`扫描失败：${e.message}`),
      },
    );
  };

  return (
    <div className="mx-auto max-w-[1720px] px-6 py-6">
      <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sidebar text-sidebar-foreground ring-1 ring-sidebar-border">
            <Database className="h-4 w-4" />
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">资产台</div>
            <div className="text-xs text-muted-foreground">Account Ops</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openScanDialog('append')}
            disabled={scan.isPending}
          >
            <RefreshCw className={cn(scan.isPending && scanMode === 'append' && 'animate-spin')} />
            扫描追加
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openScanDialog('reset')}
            disabled={scan.isPending}
          >
            清空后扫描
          </Button>
          <ThemeToggle />
        </div>
      </div>

      <ModuleNav items={NAV} />

      <div className="text-xs text-muted-foreground">
        默认扫描目录：<span className="font-mono">{settings?.card_root || purchaseRoot}</span>
      </div>

      {children}

      <Dialog open={scanOpen} onOpenChange={(open) => !scan.isPending && setScanOpen(open)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{scanMode === 'reset' ? '清空后扫描' : '扫描卡密目录'}</DialogTitle>
            <DialogDescription>
              普通扫描会追加或更新账号，不覆盖既有数据；购买批次目录继续作为邮箱归属批次的来源。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {scan.isPending && (
              <div className="flex items-center gap-2 rounded-xl border border-info/20 bg-info/10 px-3 py-2 text-sm text-info">
                <RefreshCw className="h-4 w-4 animate-spin" />
                正在扫描中，请保持此弹窗打开，完成后会自动刷新列表。
              </div>
            )}

            <div className="space-y-2">
              <Label>扫描目录</Label>
              <Input value={scanRoot} onChange={(e) => setScanRoot(e.target.value)} disabled={scan.isPending} />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" type="button" onClick={() => setScanRoot(purchaseRoot)} disabled={scan.isPending}>
                  使用购买批次目录
                </Button>
                <Button variant="outline" size="sm" type="button" onClick={() => setScanRoot(cliProxyRoot)} disabled={scan.isPending || !cliProxyRoot}>
                  使用 CLIProxy 目录
                </Button>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                当前默认：<span className="font-mono">{settings?.card_root || purchaseRoot}</span>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={saveDefault} onCheckedChange={(v) => setSaveDefault(v === true)} disabled={scan.isPending} />
              保存为默认扫描目录
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setScanOpen(false)} disabled={scan.isPending}>
                取消
              </Button>
              <Button variant={scanMode === 'reset' ? 'destructive' : 'default'} onClick={submitScan} disabled={scan.isPending}>
                {scan.isPending && <RefreshCw className="animate-spin" />}
                {submitScanText}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
      </div>
  );
}

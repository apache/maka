'use client';

import { ModuleNav, type ModuleNavItem } from '@/components/ModuleNav';

const items: ModuleNavItem[] = [
  { to: '/inventory/marketplace', label: '概览', exact: true },
  { to: '/inventory/marketplace/extract', label: '购买推送' },
  { to: '/inventory/marketplace/auto', label: '自动补池' },
  { to: '/inventory/marketplace/funds', label: '资金账户' },
  { to: '/inventory/marketplace/inventory', label: '库存' },
  { to: '/inventory/marketplace/settlement', label: '结算' },
];

// 交易台分区布局：原 TanStack Router 版改为 Next 布局 + ModuleNav 高亮。
export default function MarketplaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">交易台</h1>
        <p className="mt-1 text-sm text-muted-foreground">本地 fixture 内存态。购买、补池和入账只改本机库存。</p>
      </div>
      <ModuleNav items={items} />
      {children}
    </section>
  );
}

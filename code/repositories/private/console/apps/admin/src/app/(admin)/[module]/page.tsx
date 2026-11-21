import { notFound } from 'next/navigation';
import { MENU, MENU_PATHS } from '@/lib/menu';

export default async function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const item = MENU.find((m) => m.path === `/${module}`);
  if (!item || !MENU_PATHS.has(`/${module}`)) notFound();
  const label = decodeURIComponent(module);
  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 24, minHeight: 300 }}>
      <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>{label}</h1>
      <p style={{ color: '#666', fontSize: 14 }}>
        该模块属 P2+ 阶段（对齐 liliya Go 版 smoke_p2~p7 口径），当前仅后端表结构就绪。
      </p>
    </div>
  );
}

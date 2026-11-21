'use client';

/** 后台框架：左侧若依形制菜单 + 顶栏（会话信息/退出）。内容区由路由组子页填充。 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { MENU } from '@/lib/menu';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` };
}

export default function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userName, setUserName] = useState('');
  const [perms, setPerms] = useState<string[]>([]);

  useEffect(() => {
    void fetch('/api/me', { headers: authHeaders() }).then(async (r) => {
      if (!r.ok) {
        router.replace('/login');
        return;
      }
      const data = await r.json();
      setUserName(data.user.userName);
      setPerms(data.perms ?? []);
    });
  }, [router, pathname]);

  const visibleMenu = perms.includes('*')
    ? MENU
    : MENU.filter((m) => !m.perm || perms.includes(m.perm));

  async function logout() {
    await fetch('/api/logout', { method: 'POST', headers: authHeaders() });
    localStorage.removeItem('admin-token');
    router.replace('/login');
  }

  return (
    <div style={{ display: 'flex', minHeight: '100dvh' }}>
      <aside style={{ width: 208, background: '#1f2937', color: '#e5e7eb', flexShrink: 0 }}>
        <div style={{ padding: '16px', fontSize: 15, fontWeight: 600, borderBottom: '1px solid #374151' }}>
          liliya admin
        </div>
        <nav style={{ padding: 8 }}>
          {visibleMenu.map((m) => {
            const active = pathname === m.path || pathname.startsWith(`${m.path}/`);
            return (
              <Link
                key={m.path}
                href={m.path}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '9px 12px', borderRadius: 6, marginBottom: 2, fontSize: 14,
                  color: active ? '#fff' : '#cbd5e1', background: active ? '#2563eb' : 'transparent',
                  textDecoration: 'none',
                }}
              >
                {m.label}
                {m.status === 'todo' && (
                  <span style={{ fontSize: 10, color: '#94a3b8', border: '1px solid #475569', borderRadius: 4, padding: '0 4px' }}>
                    建设中
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        <header
          style={{
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12,
            padding: '10px 20px', background: '#fff', borderBottom: '1px solid #e5e7eb', fontSize: 13, color: '#374151',
          }}
        >
          <a href="/profile" style={{ color: '#2563eb', textDecoration: 'none' }}>{userName || '…'}</a>
          <button
            onClick={() => void logout()}
            style={{ border: 0, background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13 }}
          >
            退出
          </button>
        </header>
        <main style={{ padding: 20 }}>{children}</main>
      </div>
    </div>
  );
}

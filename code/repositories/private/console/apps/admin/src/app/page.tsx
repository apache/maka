'use client';

import { useEffect } from 'react';
import { MENU } from '@/lib/menu';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    void fetch('/api/me', { headers: authHeaders() }).then(async (r) => {
      if (!r.ok) { router.replace('/login'); return; }
      const data = await r.json();
      const perms: string[] = data.perms ?? [];
      const first = perms.includes('*')
        ? '/dashboard'
        : ['/dashboard', ...MENU.filter((m) => m.perm && perms.includes(m.perm)).map((m) => m.path)].find(Boolean);
      router.replace(first ?? '/denied');
    });
  }, [router]);
  return <p style={{ padding: 24 }}>跳转中…</p>;
}

export function authHeaders(): HeadersInit {
  const token = localStorage.getItem('admin-token') ?? '';
  return { Authorization: `Bearer ${token}` };
}

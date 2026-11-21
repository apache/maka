'use client';
import { useCallback, useEffect, useState } from 'react';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` };
}

export default function OnlinePage() {
  const [rows, setRows] = useState<Array<{ tokenMasked: string; loginName: string; userName: string; expiresAt: number }>>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/online', { headers: authHeaders() });
    const data = await res.json();
    setRows(data.rows ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function kick(token: string) {
    if (!confirm('确认强制下线？')) return;
    await fetch(`/api/online?token=${encodeURIComponent(token)}`, { method: 'DELETE', headers: authHeaders() });
    void load();
  }

  return (
    <div>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>在线用户</h1>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 10 }}>
        <thead><tr style={{ background: '#fafafa', textAlign: 'left' }}>
          {['会话', '账号', '昵称', '过期时间', '操作'].map((h) => <th key={h} style={{ padding: '10px 12px', fontSize: 13, color: '#666' }}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tokenMasked}>
              <td style={{ padding: '10px 12px', fontSize: 13, borderTop: '1px solid #eee' }}>{r.tokenMasked}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, borderTop: '1px solid #eee' }}>{r.loginName}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, borderTop: '1px solid #eee' }}>{r.userName}</td>
              <td style={{ padding: '10px 12px', fontSize: 14, borderTop: '1px solid #eee' }}>{new Date(r.expiresAt).toLocaleString()}</td>
              <td style={{ padding: '10px 12px', fontSize: 13, borderTop: '1px solid #eee' }}>
                <button onClick={() => void kick(r.tokenMasked)} style={{ border: 0, background: 'none', color: '#d03050', cursor: 'pointer' }}>强制下线</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

'use client';

/** 仪表盘：统计卡 + 近 7 天登录趋势（CSS 条形）+ 最近登录。 */
import { useEffect, useState } from 'react';

interface Dash {
  stats: { users: number; roles: number; online: number; loginsToday: number };
  trends: Array<{ date: string; count: number }>;
  recent: Array<{ user_name: string; ipaddr: string; status: string; msg: string; login_time: string }>;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` };
}

export default function DashboardPage() {
  const [dash, setDash] = useState<Dash | null>(null);

  useEffect(() => {
    void fetch('/api/dashboard', { headers: authHeaders() }).then(async (r) => {
      if (r.ok) setDash(await r.json());
    });
  }, []);

  if (!dash) return <p style={{ color: '#999' }}>加载中…</p>;
  const max = Math.max(1, ...dash.trends.map((t) => t.count));

  return (
    <div>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>仪表盘</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, margin: '14px 0' }}>
        {([['用户', dash.stats.users], ['角色', dash.stats.roles], ['在线会话', dash.stats.online], ['今日登录', dash.stats.loginsToday]] as const).map(([label, n]) => (
          <div key={label} style={{ background: '#fff', borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13, color: '#888' }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>{n}</div>
          </div>
        ))}
      </div>
      <div style={{ background: '#fff', borderRadius: 10, padding: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 14, marginBottom: 10 }}>近 7 天登录次数</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 110 }}>
          {dash.trends.map((t) => (
            <div key={t.date} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: '#666' }}>{t.count}</div>
              <div style={{ background: '#2563eb', borderRadius: 4, height: Math.max(4, (t.count / max) * 80), marginTop: 4 }} />
              <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>{t.date.slice(5)}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background: '#fff', borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 14, marginBottom: 8 }}>最近登录</div>
        {dash.recent.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, fontSize: 13, padding: '5px 0', borderTop: i ? '1px solid #f1f5f9' : undefined }}>
            <b>{r.user_name}</b>
            <span style={{ color: r.status === '0' ? '#059669' : '#d03050' }}>{r.msg}</span>
            <span style={{ color: '#999' }}>{r.ipaddr}</span>
            <span style={{ color: '#999', marginLeft: 'auto' }}>{r.login_time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

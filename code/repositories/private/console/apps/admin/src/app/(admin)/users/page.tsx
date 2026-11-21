'use client';

/** 用户管理：分页/搜索/新增/编辑状态/重置密码/删除（对齐 liliya P2 用户管理面）。 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface UserRow {
  user_id: number; dept_id: number | null; login_name: string; user_name: string;
  status: string; create_time: string | null;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}`, 'Content-Type': 'application/json' };
}
const input = { padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 } as const;
const btn = { padding: '7px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 } as const;
const linkBtn = { border: 0, background: 'none', cursor: 'pointer', fontSize: 13, padding: 0 } as const;

export default function UsersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [deptOptions, setDeptOptions] = useState<Array<{ value: number; label: string }>>([]);

  useEffect(() => {
    void fetch('/api/options', { headers: authHeaders() }).then(async (r) => {
      const data = await r.json();
      setDeptOptions(data.depts ?? []);
    });
  }, []);

  const load = useCallback(async (p: number) => {
    const res = await fetch(`/api/users?page=${p}&q=${encodeURIComponent(q)}`, { headers: authHeaders() });
    if (res.status === 401) { router.replace('/login'); return; }
    if (!res.ok) { setRows([]); setTotal(0); setError('无权访问该模块或请求失败'); return; }
    const data = await res.json();
    setRows(data.rows ?? []); setTotal(data.total ?? 0);
  }, [q, router]);

  useEffect(() => { void load(1); }, [load]);

  async function call(method: string, url: string, body?: object): Promise<boolean> {
    setError(null);
    const res = await fetch(url, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { router.replace('/login'); return false; }
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error ?? '操作失败'); return false; }
    void load(page);
    return true;
  }

  async function submitCreate() {
    if (!form.loginName?.trim() || !form.userName?.trim() || !form.password) { setError('账号、昵称与密码不能为空'); return; }
    if (await call('POST', '/api/users', form)) { setCreating(false); setForm({}); }
  }

  async function resetPwd(row: UserRow) {
    const pwd = prompt(`为 ${row.login_name} 设置新密码：`);
    if (!pwd) return;
    await call('PUT', '/api/users', { userId: row.user_id, password: pwd });
  }

  async function toggleStatus(row: UserRow) {
    await call('PUT', '/api/users', { userId: row.user_id, status: row.status === '0' ? '1' : '0' });
  }

  async function remove(row: UserRow) {
    if (!confirm(`确认删除 ${row.login_name}？（软删）`)) return;
    await call('DELETE', `/api/users?ids=${row.user_id}`);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>用户管理（{total}）</h1>
        <button onClick={() => { setCreating(true); setForm({}); }} style={{ ...btn, background: '#2563eb', color: '#fff' }}>新增用户</button>
      </div>
      {error && <p style={{ color: '#d03050', fontSize: 13 }}>{error}</p>}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索账号/昵称" style={{ ...input, margin: '12px 0', width: 240 }} />
      <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#fafafa', textAlign: 'left' }}>
            {['ID', '账号', '昵称', '状态', '创建时间', '操作'].map((h) => <th key={h} style={{ padding: '10px 12px', fontSize: 13, color: '#666' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_id}>
                <td style={tdCell}>{r.user_id}</td>
                <td style={tdCell}>{r.login_name}</td>
                <td style={tdCell}>{r.user_name}</td>
                <td style={tdCell}>{r.status === '0' ? '正常' : '停用'}</td>
                <td style={tdCell}>{r.create_time ?? '—'}</td>
                <td style={{ ...tdCell, whiteSpace: 'nowrap' }}>
                  <button onClick={() => void toggleStatus(r)} style={{ ...linkBtn, color: '#2563eb', marginRight: 10 }}>{r.status === '0' ? '停用' : '启用'}</button>
                  <button onClick={() => void resetPwd(r)} style={{ ...linkBtn, color: '#b45309', marginRight: 10 }}>重置密码</button>
                  <button onClick={() => void remove(r)} style={{ ...linkBtn, color: '#d03050' }}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button disabled={page <= 1} onClick={() => { setPage(page - 1); void load(page - 1); }} style={btn}>上一页</button>
        <span style={{ alignSelf: 'center', fontSize: 13 }}>第 {page} 页</span>
        <button disabled={page * 10 >= total} onClick={() => { setPage(page + 1); void load(page + 1); }} style={btn}>下一页</button>
      </div>

      {creating && (
        <div style={overlay}>
          <div style={dialog}>
            <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>新增用户</h2>
            {([['loginName', '账号'], ['userName', '昵称'], ['password', '密码（服务端加盐加密）']] as const).map(([k, label]) => (
              <label key={k} style={{ display: 'grid', gap: 4, marginBottom: 10, fontSize: 13 }}>
                {label} <span style={{ color: '#d03050' }}>*</span>
                <input type={k === 'password' ? 'password' : 'text'} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} style={input} />
              </label>
            ))}
            <label style={{ display: 'grid', gap: 4, marginBottom: 10, fontSize: 13 }}>
              所属部门
              <select value={form.deptId ?? ''} onChange={(e) => setForm({ ...form, deptId: e.target.value })} style={input}>
                {deptOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setCreating(false)} style={btn}>取消</button>
              <button onClick={() => void submitCreate()} style={{ ...btn, background: '#2563eb', color: '#fff' }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const tdCell = { padding: '10px 12px', fontSize: 14, borderTop: '1px solid #eee' } as const;
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', zIndex: 50 } as const;
const dialog = { background: '#fff', borderRadius: 12, padding: 24, width: 440 } as const;

'use client';

/** 若依形制通用 CRUD 表格：列表 + 新增/编辑 + 删除 + 可选清空/自定义行操作。 */
import { useCallback, useEffect, useState } from 'react';

export interface CrudColumn {
  key: string;
  label: string;
  /** 树形缩进：按该字段值渲染前缀空格 */
  indent?: boolean;
  render?: (row: Record<string, unknown>) => unknown; // 渲染时统一 String()
}
export interface CrudField {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'textarea';
  required?: boolean;
  /** 编辑时只读（如内置标记字段） */
  immutable?: boolean;
}
interface Props {
  title: string;
  endpoint: string;
  idKey: string;
  columns: CrudColumn[];
  fields?: CrudField[];
  readonly?: boolean;
  clearable?: boolean;
  clearQuery?: string;
  /** 选中行后传给自定义行操作 */
  selected?: Record<string, unknown> | null;
  onSelectedChange?: (row: Record<string, unknown> | null) => void;
  rowActions?: (row: Record<string, unknown>) => React.ReactNode;
  notice?: string;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}`, 'Content-Type': 'application/json' };
}
const cell = (row: Record<string, unknown>, col: CrudColumn) => {
  const v = row[col.key];
  if (v == null || v === '') return '—';
  return String(v);
};

export default function CrudTable({
  title, endpoint, idKey, columns, fields = [], readonly = false, clearable = false, clearQuery = '', selected, onSelectedChange, rowActions, notice,
}: Props) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` } });
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) { setRows([]); setError('无权访问该模块或请求失败'); return; }
    const data = await res.json();
    setRows(data.rows ?? []);
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setError(null);
    const missing = fields.find((f) => f.required && !form[f.key]?.trim());
    if (missing) { setError(`${missing.label} 不能为空`); return; }
    const payload: Record<string, unknown> = editing ? { [idKey]: editing[idKey] } : {};
    for (const f of fields) if (form[f.key] !== undefined && form[f.key] !== '') payload[f.key] = f.type === 'number' ? Number(form[f.key]) : form[f.key];
    const res = await fetch(endpoint, {
      method: editing ? 'PUT' : 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? '保存失败'); return; }
    setCreating(false); setEditing(null); setForm({});
    void load();
  }

  async function remove(id: unknown) {
    if (!confirm('确认删除？')) return;
    const res = await fetch(`${endpoint}?id=${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? '删除失败'); return; }
    void load();
  }

  async function clearAll() {
    if (!confirm('确认清空全部记录？')) return;
    await fetch(`${endpoint}?${clearQuery}`, { method: 'DELETE', headers: authHeaders() });
    void load();
  }

  const showForm = creating || editing;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>
          {title}
          {notice && <span style={{ fontSize: 12, color: '#888', marginLeft: 10 }}>{notice}</span>}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {clearable && (
            <button onClick={() => void clearAll()} style={{ ...btn, color: '#d03050' }}>清空</button>
          )}
          {!readonly && (
            <button onClick={() => { setCreating(true); setEditing(null); setForm({}); }} style={{ ...btn, background: '#2563eb', color: '#fff' }}>
              新增
            </button>
          )}
        </div>
      </div>
      {error && <p style={{ color: '#d03050', fontSize: 13 }}>{error}</p>}
      <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ background: '#fafafa', textAlign: 'left' }}>
            {columns.map((c) => <th key={c.key} style={th}>{c.label}</th>)}
            {!readonly && <th style={th}>操作</th>}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={columns.length + 1} style={{ ...td, textAlign: 'center', color: '#999' }}>暂无数据</td></tr>}
            {rows.map((row, i) => (
              <tr
                key={String(row[idKey]) ?? i}
                style={{ cursor: onSelectedChange ? 'pointer' : 'default', background: selected && row[idKey] === selected[idKey] ? '#eff6ff' : undefined }}
                onClick={() => onSelectedChange?.(row)}
              >
                {columns.map((c) => (
                  <td key={c.key} style={td}>
                    {c.render ? String(c.render(row))
                      : c.indent ? <span style={{ paddingLeft: Number(row.depth ?? 0) * 18 }}>{cell(row, c)}</span>
                      : cell(row, c)}
                  </td>
                ))}
                {!readonly && (
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {rowActions?.(row)}
                    {fields.length > 0 && (
                      <button onClick={() => { setEditing(row); setCreating(false); setForm(Object.fromEntries(fields.map((f) => [f.key, String(row[f.key] ?? '')]))); }} style={{ ...linkBtn, marginRight: 8 }}>编辑</button>
                    )}
                    <button onClick={() => void remove(row[idKey])} style={{ ...linkBtn, color: '#d03050' }}>删除</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div style={overlay}>
          <div style={dialog}>
            <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>{editing ? '编辑' : '新增'}{title}</h2>
            {fields.map((f) => (
              <label key={f.key} style={{ display: 'grid', gap: 4, marginBottom: 10, fontSize: 13 }}>
                {f.label}{f.required && <span style={{ color: '#d03050' }}> *</span>}
                {f.type === 'textarea' ? (
                  <textarea value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} rows={4} style={input} readOnly={!!editing && f.immutable} />
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    style={input}
                    readOnly={!!editing && f.immutable}
                  />
                )}
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setCreating(false); setEditing(null); }} style={btn}>取消</button>
              <button onClick={() => void save()} style={{ ...btn, background: '#2563eb', color: '#fff' }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 13, color: '#666' } as const;
const td = { padding: '10px 12px', fontSize: 14, borderTop: '1px solid #eee' } as const;
const btn = { padding: '7px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 } as const;
const linkBtn = { border: 0, background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, padding: 0 } as const;
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', zIndex: 50 } as const;
const dialog = { background: '#fff', borderRadius: 12, padding: 24, width: 440, maxHeight: '80vh', overflow: 'auto' } as const;
const input = { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, width: '100%', boxSizing: 'border-box' } as const;

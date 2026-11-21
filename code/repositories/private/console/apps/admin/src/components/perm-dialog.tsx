'use client';

/** 角色-菜单权限分配对话框：DFS 展平树勾选（M/C/F），全量替换保存。 */
import { useCallback, useEffect, useState } from 'react';

interface TreeRow {
  menu_id: number;
  menu_name: string;
  menu_type: string;
  perms: string;
  depth: number;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}`, 'Content-Type': 'application/json' };
}

const TYPE_LABEL: Record<string, string> = { M: '目录', C: '菜单', F: '按钮' };

export default function PermDialog({ roleId, roleName, onClose }: { roleId: number; roleName: string; onClose: () => void }) {
  const [rows, setRows] = useState<TreeRow[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/roles/menu-tree?roleId=${roleId}`, { headers: { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` } });
    const data = await res.json();
    setRows(data.rows ?? []);
    setChecked(new Set(data.menuIds ?? []));
  }, [roleId]);

  useEffect(() => { void load(); }, [load]);

  function toggle(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch('/api/roles/menu-assign', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ roleId, menuIds: [...checked] }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(data.error ?? '保存失败'); return; }
    onClose();
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>分配权限 · {roleName}</h2>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 10px' }}>
          勾选该角色可用的菜单与操作权限点；改动保存后立即生效（无需重启）。
        </p>
        {error && <p style={{ color: '#d03050', fontSize: 13 }}>{error}</p>}
        <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
          {rows.map((r) => (
            <label
              key={r.menu_id}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 13, paddingLeft: r.depth * 20, cursor: 'pointer' }}
            >
              <input type="checkbox" checked={checked.has(r.menu_id)} onChange={() => toggle(r.menu_id)} />
              <span>{r.menu_name}</span>
              <span style={{ fontSize: 11, color: '#999' }}>[{TYPE_LABEL[r.menu_type] ?? r.menu_type}]</span>
              {r.perms && <code style={{ fontSize: 11, color: '#64748b' }}>{r.perms}</code>}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <span style={{ fontSize: 12, color: '#888', marginRight: 'auto', alignSelf: 'center' }}>已选 {checked.size} 项</span>
          <button onClick={onClose} style={btn}>取消</button>
          <button onClick={() => void save()} disabled={saving} style={{ ...btn, background: '#2563eb', color: '#fff' }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', zIndex: 60 } as const;
const dialog = { background: '#fff', borderRadius: 12, padding: 24, width: 560, maxHeight: '85vh', overflow: 'auto' } as const;
const btn = { padding: '7px 14px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 } as const;

'use client';

/** 角色管理：CRUD（CrudTable）+ 权限分配（PermDialog）。 */
import { useState } from 'react';
import CrudTable from '@/components/crud-table';
import PermDialog from '@/components/perm-dialog';

export default function RolesPage() {
  const [assigning, setAssigning] = useState<{ roleId: number; roleName: string } | null>(null);

  return (
    <>
      <CrudTable
        title="角色管理"
        endpoint="/api/roles"
        idKey="role_id"
        columns={[
          { key: 'role_id', label: 'ID' },
          { key: 'role_name', label: '角色名称' },
          { key: 'role_key', label: '权限字符' },
          { key: 'role_sort', label: '排序' },
          { key: 'user_count', label: '用户数' },
          { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '停用') },
          { key: 'remark', label: '备注' },
        ]}
        fields={[
          { key: 'roleName', label: '角色名称', required: true },
          { key: 'roleKey', label: '权限字符', required: true },
          { key: 'roleSort', label: '排序', type: 'number' },
          { key: 'remark', label: '备注', type: 'textarea' },
        ]}
        rowActions={(row) => (
          <button
            onClick={() => setAssigning({ roleId: Number(row.role_id), roleName: String(row.role_name) })}
            style={{ border: 0, background: 'none', color: '#b45309', cursor: 'pointer', fontSize: 13, marginRight: 8 }}
          >
            分配权限
          </button>
        )}
        notice="内置超级管理员禁改禁删（全通过语义）；被用户引用禁删"
      />
      {assigning && <PermDialog roleId={assigning.roleId} roleName={assigning.roleName} onClose={() => setAssigning(null)} />}
    </>
  );
}

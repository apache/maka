'use client';
import CrudTable from '@/components/crud-table';

export default function MenusPage() {
  return (
    <CrudTable
      title="菜单管理"
      endpoint="/api/menus"
      idKey="menu_id"
      columns={[
        { key: 'menu_name', label: '菜单名称', indent: true },
        { key: 'menu_type', label: '类型', render: (r) => ({ M: '目录', C: '菜单', F: '按钮' })[String(r.menu_type)] ?? r.menu_type },
        { key: 'path', label: '路由地址' },
        { key: 'perms', label: '权限标识' },
        { key: 'order_num', label: '排序' },
      ]}
      fields={[
        { key: 'menuName', label: '菜单名称', required: true },
        { key: 'menuType', label: '类型（M/C/F）', required: true },
        { key: 'parentId', label: '上级ID', type: 'number' },
        { key: 'orderNum', label: '排序', type: 'number' },
        { key: 'path', label: '路由地址' },
        { key: 'perms', label: '权限标识' },
      ]}
      notice="树形（M目录/C菜单/F按钮）；有子菜单禁删"
    />
  );
}

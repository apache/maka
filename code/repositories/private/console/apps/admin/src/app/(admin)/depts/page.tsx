'use client';
import CrudTable from '@/components/crud-table';

export default function DeptsPage() {
  return (
    <CrudTable
      title="部门管理"
      endpoint="/api/depts"
      idKey="dept_id"
      columns={[
        { key: 'dept_name', label: '部门名称', indent: true },
        { key: 'dept_id', label: 'ID' },
        { key: 'order_num', label: '排序' },
        { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '停用') },
        { key: 'ancestors', label: '祖先链' },
      ]}
      fields={[
        { key: 'deptName', label: '部门名称', required: true },
        { key: 'parentId', label: '上级部门ID', type: 'number' },
        { key: 'orderNum', label: '排序', type: 'number' },
      ]}
      notice="DFS 展平缩进；有子级/用户禁删"
    />
  );
}

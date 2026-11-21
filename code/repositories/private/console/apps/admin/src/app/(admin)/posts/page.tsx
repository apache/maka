'use client';
import CrudTable from '@/components/crud-table';

export default function PostsPage() {
  return (
    <CrudTable
      title="岗位管理"
      endpoint="/api/posts"
      idKey="post_id"
      columns={[
        { key: 'post_id', label: 'ID' },
        { key: 'post_code', label: '岗位编码' },
        { key: 'post_name', label: '岗位名称' },
        { key: 'post_sort', label: '排序' },
        { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '停用') },
      ]}
      fields={[
        { key: 'postCode', label: '岗位编码', required: true },
        { key: 'postName', label: '岗位名称', required: true },
        { key: 'postSort', label: '排序', type: 'number' },
      ]}
      notice="编码/名称唯一；已分配禁删"
    />
  );
}

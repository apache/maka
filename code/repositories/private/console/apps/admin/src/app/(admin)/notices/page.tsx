'use client';
import CrudTable from '@/components/crud-table';

export default function NoticesPage() {
  return (
    <CrudTable
      title="通知公告"
      endpoint="/api/notices"
      idKey="notice_id"
      columns={[
        { key: 'notice_id', label: 'ID' },
        { key: 'notice_title', label: '标题' },
        { key: 'notice_type', label: '类型', render: (r) => (r.notice_type === '1' ? '通知' : '公告') },
        { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '关闭') },
        { key: 'create_time', label: '创建时间' },
      ]}
      fields={[
        { key: 'noticeTitle', label: '标题', required: true },
        { key: 'noticeType', label: '类型（1通知/2公告）', required: true },
        { key: 'noticeContent', label: '正文', type: 'textarea' },
      ]}
      notice="列表不拖正文，编辑取详情"
    />
  );
}

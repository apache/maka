'use client';
import CrudTable from '@/components/crud-table';

export default function LoginLogsPage() {
  return (
    <CrudTable
      title="登录日志"
      endpoint="/api/login-logs"
      idKey="info_id"
      readonly
      clearable
      clearQuery="all=1"
      columns={[
        { key: 'info_id', label: 'ID' },
        { key: 'user_name', label: '账号' },
        { key: 'ipaddr', label: 'IP' },
        { key: 'status', label: '结果', render: (r) => (r.status === '0' ? '成功' : '失败') },
        { key: 'msg', label: '消息' },
        { key: 'login_time', label: '时间' },
      ]}
      notice="登录成功/失败均记录"
    />
  );
}

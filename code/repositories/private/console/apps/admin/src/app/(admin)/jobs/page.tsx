'use client';
import CrudTable from '@/components/crud-table';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}`, 'Content-Type': 'application/json' };
}

export default function JobsPage() {
  return (
    <CrudTable
      title="定时任务"
      endpoint="/api/jobs"
      idKey="job_id"
      columns={[
        { key: 'job_id', label: 'ID' },
        { key: 'job_name', label: '任务名称' },
        { key: 'invoke_target', label: '调用目标' },
        { key: 'cron_expression', label: 'cron 表达式' },
        { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '暂停') },
      ]}
      fields={[
        { key: 'jobName', label: '任务名称', required: true },
        { key: 'invokeTarget', label: '调用目标（noop / echoParam(参数)）', required: true },
        { key: 'cronExpression', label: 'cron 表达式' },
        { key: 'remark', label: '备注', type: 'textarea' },
      ]}
      rowActions={(row) => (
        <button
          onClick={async () => {
            const res = await fetch('/api/jobs/run', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ jobId: row.job_id }) });
            const data = await res.json();
            alert(data.message ?? data.error ?? '已执行');
          }}
          style={{ border: 0, background: 'none', color: '#059669', cursor: 'pointer', fontSize: 13, marginRight: 8 }}
        >
          执行一次
        </button>
      )}
      notice="调度循环 P3 承接（misfire/并发首期仅存储）；执行结果写 sys_job_log"
    />
  );
}

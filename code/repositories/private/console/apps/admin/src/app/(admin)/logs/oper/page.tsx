'use client';
import CrudTable from '@/components/crud-table';

export default function OperLogsPage() {
  return (
    <CrudTable
      title="操作日志"
      endpoint="/api/oper-logs"
      idKey="oper_id"
      readonly
      clearable
      clearQuery="all=1"
      columns={[
        { key: 'oper_id', label: 'ID' },
        { key: 'title', label: '模块' },
        { key: 'business_type', label: '类型', render: (r) => ({ 1: '新增', 2: '修改', 3: '删除' })[String(r.business_type)] ?? r.business_type },
        { key: 'oper_name', label: '操作人' },
        { key: 'oper_param', label: '参数' },
        { key: 'oper_time', label: '时间' },
        { key: 'cost_time', label: '耗时(ms)' },
      ]}
      notice="写操作自动记录（参数已脱敏）"
    />
  );
}

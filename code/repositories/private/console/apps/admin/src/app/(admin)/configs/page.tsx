'use client';
import CrudTable from '@/components/crud-table';

export default function ConfigsPage() {
  return (
    <CrudTable
      title="参数设置"
      endpoint="/api/configs"
      idKey="config_id"
      columns={[
        { key: 'config_id', label: 'ID' },
        { key: 'config_name', label: '参数名称' },
        { key: 'config_key', label: '键名' },
        { key: 'config_value', label: '键值' },
        { key: 'config_type', label: '内置', render: (r) => (r.config_type === 'Y' ? '是' : '否') },
        { key: 'remark', label: '备注' },
      ]}
      fields={[
        { key: 'configName', label: '参数名称', required: true },
        { key: 'configValue', label: '键值' },
        { key: 'remark', label: '备注', type: 'textarea' },
      ]}
      notice="键名唯一；内置参数（Y）禁删"
    />
  );
}

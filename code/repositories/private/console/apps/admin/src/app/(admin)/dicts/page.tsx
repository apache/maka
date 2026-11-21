'use client';
import CrudTable from '@/components/crud-table';

export default function DictsPage() {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <CrudTable
        title="字典类型"
        endpoint="/api/dicts"
        idKey="dict_id"
        columns={[
          { key: 'dict_id', label: 'ID' },
          { key: 'dict_name', label: '字典名称' },
          { key: 'dict_type', label: '字典类型' },
          { key: 'status', label: '状态', render: (r) => (r.status === '0' ? '正常' : '停用') },
          { key: 'remark', label: '备注' },
        ]}
        fields={[
          { key: 'dictName', label: '字典名称', required: true },
          { key: 'dictType', label: '字典类型', required: true },
          { key: 'remark', label: '备注', type: 'textarea' },
        ]}
        notice="类型删除连带清理数据"
      />
      <CrudTable
        title="字典数据"
        endpoint="/api/dicts?dictType=sys_yes_no"
        idKey="dict_code"
        columns={[
          { key: 'dict_code', label: 'ID' },
          { key: 'dict_label', label: '标签' },
          { key: 'dict_value', label: '键值' },
          { key: 'dict_type', label: '所属类型' },
          { key: 'is_default', label: '默认' },
        ]}
        fields={[
          { key: 'dictType', label: '所属类型', required: true },
          { key: 'dictLabel', label: '标签', required: true },
          { key: 'dictValue', label: '键值', required: true },
        ]}
        notice="数据页按类型过滤（现挂 sys_yes_no 示例）"
      />
    </div>
  );
}

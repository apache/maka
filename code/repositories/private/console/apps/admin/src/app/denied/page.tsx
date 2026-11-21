export default function DeniedPage() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 18 }}>没有可访问的模块</h1>
        <p style={{ color: '#666', fontSize: 14 }}>当前账号未授予任何模块权限，请联系管理员在「角色管理 → 分配权限」中授权。</p>
      </div>
    </div>
  );
}

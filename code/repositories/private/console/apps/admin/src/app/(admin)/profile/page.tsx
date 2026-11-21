'use client';

/** 个人中心：改资料 + 改密码（旧密码校验）。 */
import { useEffect, useState } from 'react';

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}`, 'Content-Type': 'application/json' };
}
const input = { padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, width: 280 } as const;
const btn = { padding: '8px 18px', border: 0, borderRadius: 8, background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13 } as const;

export default function ProfilePage() {
  const [info, setInfo] = useState({ userName: '', email: '', phonenumber: '', loginName: '', createTime: '' });
  const [msg, setMsg] = useState('');
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');

  useEffect(() => {
    void fetch('/api/profile', { headers: { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` } }).then(async (r) => {
      const data = await r.json();
      if (data.row) {
        const { login_name, user_name, email, phonenumber, create_time } = data.row;
        setInfo({ loginName: login_name, userName: user_name ?? '', email: email ?? '', phonenumber: phonenumber ?? '', createTime: create_time ?? '' });
      }
    });
  }, []);

  async function saveInfo() {
    setMsg('');
    const res = await fetch('/api/profile', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ userName: info.userName, email: info.email, phonenumber: info.phonenumber }) });
    setMsg(res.ok ? '资料已保存' : ((await res.json()).error ?? '保存失败'));
  }

  async function changePwd() {
    setPwdMsg('');
    const res = await fetch('/api/profile/password', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }) });
    const data = await res.json().catch(() => ({}));
    setPwdMsg(res.ok ? '密码已修改（下次登录用新密码）' : (data.error ?? '修改失败'));
    if (res.ok) { setOldPwd(''); setNewPwd(''); }
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 20 }}>
        <h1 style={{ fontSize: 16, marginTop: 0 }}>个人资料</h1>
        <p style={{ fontSize: 13, color: '#888' }}>账号 {info.loginName} · 创建于 {info.createTime || '—'}</p>
        {([['userName', '昵称'], ['email', '邮箱'], ['phonenumber', '手机号']] as const).map(([k, label]) => (
          <label key={k} style={{ display: 'grid', gap: 4, marginBottom: 10, fontSize: 13 }}>
            {label}
            <input value={info[k]} onChange={(e) => setInfo({ ...info, [k]: e.target.value })} style={input} />
          </label>
        ))}
        <button onClick={() => void saveInfo()} style={btn}>保存资料</button>
        {msg && <span style={{ marginLeft: 10, fontSize: 13, color: '#059669' }}>{msg}</span>}
      </div>
      <div style={{ background: '#fff', borderRadius: 10, padding: 20 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>修改密码</h2>
        <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} placeholder="旧密码" style={{ ...input, display: 'block', marginBottom: 10 }} />
        <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="新密码（至少 6 位）" style={{ ...input, display: 'block', marginBottom: 10 }} />
        <button onClick={() => void changePwd()} style={btn}>修改密码</button>
        {pwdMsg && <span style={{ marginLeft: 10, fontSize: 13, color: '#059669' }}>{pwdMsg}</span>}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MENU } from '@/lib/menu';

export default function LoginPage() {
  const router = useRouter();
  const [loginName, setLoginName] = useState('admin');
  const [password, setPassword] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refreshCaptcha = useCallback(async () => {
    const res = await fetch('/api/captcha');
    const data = await res.json();
    setCaptchaId(data.captchaId);
    setCaptchaSvg(data.svg);
    setCaptchaCode('');
  }, []);

  useEffect(() => { void refreshCaptcha(); }, [refreshCaptcha]);

  async function submit() {
    setError(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName, password, captchaId, captchaCode }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? '登录失败');
      void refreshCaptcha(); // 一次性验证码：失败即换
      return;
    }
    localStorage.setItem('admin-token', data.token);
    // 按权限落位：管理员进用户管理，受限用户进第一个可见模块
    const perms: string[] = data.perms ?? [];
    const first = perms.includes('*')
      ? '/dashboard'
      : ['/dashboard', ...MENU.filter((m) => m.perm && perms.includes(m.perm)).map((m) => m.path)].find(Boolean);
    router.replace(first ?? '/denied');
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        style={{ display: 'grid', gap: 12, width: 320, padding: 32, background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,.06)' }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>liliya admin 登录</h1>
        <input value={loginName} onChange={(e) => setLoginName(e.target.value)} placeholder="账号" style={input} />
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="密码" style={input} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value)} placeholder="算式结果" style={{ ...input, flex: 1 }} />
          <div
            onClick={() => void refreshCaptcha()}
            title="点击刷新"
            style={{ width: 120, height: 40, cursor: 'pointer', flexShrink: 0, borderRadius: 6, overflow: 'hidden' }}
            dangerouslySetInnerHTML={{ __html: captchaSvg }}
          />
        </div>
        {error && <p style={{ color: '#d03050', margin: 0, fontSize: 13 }}>{error}</p>}
        <button type="submit" style={{ padding: '10px 0', border: 0, borderRadius: 8, background: '#2563eb', color: '#fff', cursor: 'pointer' }}>
          登录（种子账号 admin / admin123）
        </button>
      </form>
    </div>
  );
}

const input = { padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 } as const;

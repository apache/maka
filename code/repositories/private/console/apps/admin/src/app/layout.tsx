import type { ReactNode } from 'react';

export const metadata = { title: 'liliya admin · 若依形制管理后台' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f6f8' }}>{children}</body>
    </html>
  );
}

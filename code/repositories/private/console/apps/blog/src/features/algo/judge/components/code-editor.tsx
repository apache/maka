'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

// Monaco 仅浏览器运行且体积大,用 next/dynamic + ssr:false 延迟加载
// (符合 vercel-react-best-practices 的 bundle-dynamic-imports 规则)
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <div className="h-[360px] animate-pulse rounded-md border bg-muted/30" />,
});

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Monaco 语言标识。 */
  language?: string;
}

/**
 * 代码编辑器(Monaco,客户端动态加载)。
 *
 * 主题跟随应用明暗(读 <html> 的 .dark 类,ThemeToggle 切换时经 MutationObserver 同步):
 * 暗色用 `vs-dark`,亮色用 `vs`,避免编辑器与界面割裂。挂载前按暗色处理。
 */
export function CodeEditor({ value, onChange, language = 'javascript' }: CodeEditorProps) {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const el = document.documentElement;
    const read = () => setIsDark(el.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const monacoTheme = isDark ? 'vs-dark' : 'vs';

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <MonacoEditor
        height="360px"
        language={language}
        theme={monacoTheme}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        options={{
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          tabSize: 2,
          automaticLayout: true,
        }}
      />
    </div>
  );
}

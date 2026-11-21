'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useTheme } from '@ggbdpq/console-ui';

// 全局客户端 Provider：react-query + sonner 通知（主题随统一 theme module）。
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  const { resolvedTheme } = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="top-right" theme={resolvedTheme} />
    </QueryClientProvider>
  );
}

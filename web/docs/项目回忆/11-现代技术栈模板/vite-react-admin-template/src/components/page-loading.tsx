import { cn } from '@/lib/utils';
import { LoaderCircle } from 'lucide-react';

/** 路由级 Suspense / 页面加载态 */
export function PageLoading({ className, label = '加载中…' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex h-full min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground', className)}>
      <LoaderCircle className="size-6 animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useGlobalStore } from '@/stores/global';
import { checkPagePermission } from '@/helpers/permission';
import { PageLoading } from '@/components/page-loading';

/** 路由守卫：初始化引导 + 页面权限校验 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const systemReady = useGlobalStore((s) => s.systemReady);
  const bootstrap = useGlobalStore((s) => s.bootstrap);
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!systemReady) return <PageLoading />;
  // 页面权限不通过时进 404（动态路由匹配逻辑在 helpers/permission）
  if (!checkPagePermission(location.pathname)) return <Navigate to="/404" replace />;

  return children;
}

import { createBrowserRouter, redirect } from 'react-router';
import type { ComponentType } from 'react';
import { BasicLayout } from '@/layouts/basic-layout';
import { RequireAuth } from '@/components/require-auth';

/** 路由懒加载的薄适配：把 default 导出映射成 React Router 的 Component */
const to = (loader: () => Promise<{ default: ComponentType }>) => async () => ({
  Component: (await loader()).default,
});

export const router = createBrowserRouter([
  {
    element: <RequireAuth><BasicLayout /></RequireAuth>,
    children: [
      { path: '/', loader: () => redirect('/dashboard') },
      { path: '/dashboard', lazy: to(() => import('@/pages/dashboard')) },
      { path: '/users', lazy: to(() => import('@/pages/users')) },
    ],
  },
  { path: '/404', lazy: to(() => import('@/pages/not-found')) },
  { path: '*', lazy: to(() => import('@/pages/not-found')) },
]);

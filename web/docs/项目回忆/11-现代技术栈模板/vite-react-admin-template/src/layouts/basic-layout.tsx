import { Outlet, useLocation, Link } from 'react-router';
import { LogOut } from 'lucide-react';
import { useGlobalStore } from '@/stores/global';
import { BASIS_MENU } from '@/constants/menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 主布局：侧边菜单 + 顶部面包屑/用户区 + 内容出口（对标原模板 layouts/ 三件套） */
export function BasicLayout() {
  const menus = useGlobalStore((s) => s.menus);
  const userInfo = useGlobalStore((s) => s.userInfo);
  const logout = useGlobalStore((s) => s.logout);
  const location = useLocation();

  const activeMenu =
    menus.find((item) => item.path === location.pathname) ??
    BASIS_MENU.find((item) => item.path === location.pathname);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 侧边菜单 */}
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-14 items-center border-b px-5 text-base font-semibold">
          Admin 管理系统
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {menus.map((item) => {
            const active = item.path === location.pathname;
            return (
              <Link
                key={item.key}
                to={item.path}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                )}
              >
                <item.icon className="size-4" />
                {item.title}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部栏 */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background px-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>首页</BreadcrumbItem>
              {activeMenu && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeMenu.title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 px-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
                  {(userInfo?.name ?? 'T').slice(0, 1)}
                </span>
                <span className="text-sm">{userInfo?.name ?? '模板模式'}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>
                {userInfo ? `${userInfo.enName}（${userInfo.employeeId}）` : '未接入用户体系'}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
                <LogOut />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* 内容出口 */}
        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

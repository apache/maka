import { Suspense, useEffect, useState } from "react";
import { Menu, Moon, Sun } from "lucide-react";
import { Link, NavLink } from "@ig/router";
import { Button } from "@ig/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@ig/components/ui/sheet";
import { Toaster } from "@ig/components/ui/sonner";
import { useArena } from "@ig/state/store";
import type { ThemeMode } from "@ig/state/store";

const NAV = [
  { to: "/", label: "仪表盘", end: true },
  { to: "/practice", label: "练习", end: true },
  { to: "/bank", label: "题库" },
  { to: "/review", label: "复盘" },
  { to: "/stats", label: "统计" },
  { to: "/exams", label: "模拟卷" },
  { to: "/interview", label: "AI 面试官" },
  { to: "/records", label: "记录" },
  { to: "/settings", label: "设置" },
];

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive
    ? "rounded-md bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
    : "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground";
}

function ThemeToggle() {
  const theme = useArena((s) => s.theme);
  const setTheme = useArena((s) => s.setTheme);
  const next: ThemeMode = theme === "dark" ? "light" : "dark";
  return (
    <Button variant="ghost" size="icon" aria-label="切换深浅主题" onClick={() => setTheme(next)}>
      {theme === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}
    </Button>
  );
}

// 六期并入适配：主题不再写 <html class>（会污染 agent 全局主题），改为返回 dark 布尔值，
// 由特性根 div（.interview-gym-root.dark）承接，dark: 变体按 Tailwind 默认后代选择器生效。
function useApplyTheme() {
  const theme = useArena((s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  const dark = theme === "dark" || (theme === "system" && systemDark);
  return dark;
}

// 六期并入适配：react-router 的 Outlet 由 App Router layout children 取代
export function Layout({ children }: { children: React.ReactNode }) {
  const dark = useApplyTheme();
  return (
    <div className={`interview-gym-root min-h-screen bg-background text-foreground ${dark ? "dark" : ""}`}>
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-2 px-4">
          <Link to="/" className="shrink-0 text-base font-semibold">
            面试自练场
          </Link>
          <nav className="hidden items-center gap-0.5 lg:flex">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开菜单">
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-56">
                <SheetTitle>面试自练场</SheetTitle>
                <nav className="mt-2 flex flex-col gap-1">
                  {NAV.map((item) => (
                    <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                      {item.label}
                    </NavLink>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-6">
        <Suspense fallback={<p className="text-sm text-muted-foreground">题库加载中…</p>}>
          {children}
        </Suspense>
      </main>
      <Toaster position="top-center" />
    </div>
  );
}

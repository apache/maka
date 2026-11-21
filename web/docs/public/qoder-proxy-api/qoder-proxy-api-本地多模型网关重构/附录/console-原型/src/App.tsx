import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useStore } from "./store";
import { startSimulation } from "./sim";
import { startLive } from "./live";
import { cx, Dot } from "./components/ui";

const NAV = [
  { to: "/agents", label: "Agent" },
  { to: "/providers", label: "供应商" },
  { to: "/routing", label: "路由" },
  { to: "/usage", label: "用量" },
];
// magpie 还有 网关 / 会话 / 资源库 / 插件：本项目不做或后置，见 00-评审 §3

export function App() {
  const { mode, connection, gatewayAddr, tick, theme, setTheme } = useStore();
  const navigate = useNavigate();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const live = q.get("live");
    if (q.get("theme") === "dark") setTheme("dark");
    const stop = live ? startLive(live, q.get("token") ?? "") : (useStore.setState({ connection: "open" }), startSimulation());
    const t = window.setInterval(tick, 500);
    return () => {
      stop();
      clearInterval(t);
    };
  }, [tick, setTheme]);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-[1080px] items-center gap-4 px-6">
          <div className="flex min-w-[200px] items-center gap-2 text-[12.5px]">
            <span className="font-semibold">qoder-proxy-api</span>
            <span className="flex items-center gap-1 text-muted">
              <Dot tone={connection === "open" ? "ok" : connection === "connecting" ? "warn" : "bad"} />
              <span className="font-mono">{gatewayAddr}</span>
              {mode === "mock" && <span className="rounded bg-warn-soft px-1 text-[10.5px] text-warn">演示数据</span>}
            </span>
          </div>
          <nav className="mx-auto flex rounded-xl bg-pill p-[3px]" aria-label="主导航">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cx(
                    "rounded-[9px] px-3.5 py-[5px] text-[12.5px] transition-colors",
                    isActive || (n.to === "/agents" && window.location.hash.replace(/^#/, "") === "/") ? "bg-card font-medium text-fg shadow-card" : "text-muted hover:text-fg",
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex min-w-[200px] items-center justify-end gap-1 text-muted">
            <button className="rounded-lg p-1.5 hover:bg-pill hover:text-fg" title="刷新" onClick={() => window.location.reload()}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>
            </button>
            <button className="rounded-lg p-1.5 hover:bg-pill hover:text-fg" title={theme === "dark" ? "浅色" : "深色"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" /></svg>
            </button>
            <button className="rounded-lg p-1.5 hover:bg-pill hover:text-fg" title="设置" onClick={() => navigate("/settings")}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></svg>
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1080px] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

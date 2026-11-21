// 原型里的最小 UI 原语（shadcn 风格的 className 约定）。正式版用 shadcn CLI v4 生成 Dialog/Select/Switch 替换。
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-line bg-card shadow-card", className)}>{children}</div>;
}

export function Button({ variant = "ghost", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "primary" | "pill" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12.5px] transition-colors disabled:opacity-40",
        variant === "primary" && "bg-accent text-white hover:opacity-90",
        variant === "pill" && "bg-pill text-fg hover:bg-sel",
        variant === "ghost" && "text-muted hover:bg-pill hover:text-fg",
        className,
      )}
    />
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx("relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-faint/60")}
    >
      <span className={cx("absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all", on ? "left-[19px]" : "left-[3px]")} />
    </button>
  );
}

export function Dot({ tone, live }: { tone: "ok" | "bad" | "warn" | "muted" | "accent"; live?: boolean }) {
  const c = { ok: "bg-ok", bad: "bg-bad", warn: "bg-warn", muted: "bg-faint", accent: "bg-accent" }[tone];
  return <span className={cx("inline-block h-[7px] w-[7px] shrink-0 rounded-full", c, live && "dot-live")} />;
}

export function Badge({ tone = "muted", children }: { tone?: "ok" | "bad" | "warn" | "muted" | "accent"; children: ReactNode }) {
  const c = {
    ok: "bg-ok-soft text-ok",
    bad: "bg-bad-soft text-bad",
    warn: "bg-warn-soft text-warn",
    muted: "bg-pill text-muted",
    accent: "bg-accent-soft text-accent",
  }[tone];
  return <span className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-[1px] text-[11px] font-medium", c)}>{children}</span>;
}

export function PillSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        "max-w-[220px] cursor-pointer appearance-none truncate rounded-lg bg-pill py-1 pl-2.5 pr-6 font-mono text-[12px] text-fg outline-none hover:bg-sel",
        "bg-[length:10px] bg-[right_8px_center] bg-no-repeat",
        className,
      )}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2385858d' fill='none' stroke-width='1.4'/%3E%3C/svg%3E\")" }}
    />
  );
}

// 不用供应商/Agent 的官方 logo：统一用首字母方块，颜色由 id 决定。
const PALETTE = ["#4f46e5", "#0f9d8a", "#d97757", "#2563eb", "#9333ea", "#ca8a04", "#db2777", "#475569"];
export function Mark({ id, label, size = 28 }: { id: string; label: string; size?: number }) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const bg = PALETTE[h % PALETTE.length];
  const text = label.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "").slice(0, 2);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.38 }}
      aria-hidden
    >
      {text}
    </span>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6" onMouseDown={onClose}>
      <div className="w-full max-w-[560px] rounded-2xl border border-line bg-card shadow-xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-[14px] font-semibold">{title}</div>
          <Button onClick={onClose} aria-label="关闭"><XIcon /></Button>
        </div>
        <div className="max-h-[65vh] overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, right }: { title: string; sub: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted">{sub}</div>
      </div>
      {right}
    </div>
  );
}

export function XIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>;
}

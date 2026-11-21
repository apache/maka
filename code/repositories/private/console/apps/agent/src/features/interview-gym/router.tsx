"use client";

// 六期并入适配层：react-router → Next App Router。原站路由全部搬进 app/interview-gym/**，
// 本模块只做三件事：路径加 /interview-gym 前缀（withBase）、Link/NavLink 换 next/link 实现、
// useParams 透传 next/navigation。useNavigate/useLocation/useSearchParams 原站零使用，不设。
import LinkNext from "next/link";
import { usePathname, useParams as useNextParams } from "next/navigation";
import type { ReactNode } from "react";

export const BASE = "/interview-gym";

export function withBase(to: string): string {
  if (/^(https?:|#|mailto:)/.test(to)) return to;
  return to === "/" ? BASE : `${BASE}${to}`;
}

interface LinkProps {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: () => void;
}

export function Link({ to, ...rest }: LinkProps) {
  return <LinkNext href={withBase(to)} {...rest} />;
}

interface NavLinkProps extends Omit<LinkProps, "className"> {
  end?: boolean;
  className: string | ((state: { isActive: boolean }) => string);
}

export function NavLink({ to, end, className, children }: NavLinkProps) {
  const pathname = usePathname();
  const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname;
  const isActive = end ? rel === to : rel === to || rel.startsWith(`${to}/`);
  const cls = typeof className === "function" ? className({ isActive }) : className;
  return (
    <LinkNext href={withBase(to)} className={cls}>
      {children}
    </LinkNext>
  );
}

// react-router 的 useParams 自动做 URL 解码，next/navigation 保留编码态——在适配层补齐，
// 否则中文 slug（如 /bank/P0-必背）到业务层还是 %E5%BF%85… 形态。
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function useParams(): Record<string, string | string[] | undefined> {
  const raw = useNextParams();
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = safeDecode(value);
    else if (Array.isArray(value)) out[key] = value.map(safeDecode);
    else out[key] = value;
  }
  return out;
}

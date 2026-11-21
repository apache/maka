'use client';

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

// 六期并入：react-router 布局路由 → App Router layout，Outlet 由 children 取代。
// gym 整树是浏览器 SPA（Vite 出身，window/localStorage 直用），按 course/deck 先例 ssr:false 挂载。
const GymLayout = dynamic(() => import("@ig/components/Layout").then((m) => m.Layout), { ssr: false });

export default function InterviewGymLayout({ children }: { children: ReactNode }) {
  return <GymLayout>{children}</GymLayout>;
}

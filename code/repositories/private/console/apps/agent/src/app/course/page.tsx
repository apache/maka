'use client';

import dynamic from "next/dynamic";
import "@/features/course/index.css";

// 课程本体是 Vite SPA 的 verbatim 移植：hash 路由/侧栏搜索/分步播放引擎零改动，
// 仅以 dynamic(ssr:false) 取代 Vite createRoot 入口（读 hash 需浏览器端）。
const CourseApp = dynamic(() => import("@/features/course/App"), { ssr: false });

// 样式已作用域化到 .course-root（原站 :root/body 全局规则就近包裹，其余零改动）
export default function CoursePage() {
  return (
    <div className="course-root" style={{ minHeight: "100dvh" }}>
      <CourseApp />
    </div>
  );
}

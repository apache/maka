// 首帧前按 localStorage/系统偏好挂 .dark，防白闪。
// 与 base.css 的 .dark 块、theme-toggle 的 localStorage key "theme" 三方对齐。
// 仅服务端渲染输出 <script>（Server Component 无客户端重渲染），Next16 的
// "script tag inside React component" 告警即源于客户端渲染 script 标签。
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`;

export function ThemeScript() {
  if (typeof window !== "undefined") return null;
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}

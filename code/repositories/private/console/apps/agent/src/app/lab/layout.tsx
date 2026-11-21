// 实验室是自带全屏顶栏的教学场，直接全出血；.lab-root 承载暗色终端主题作用域。
export default function LabLayout({ children }: { children: React.ReactNode }) {
  return <div className="lab-root">{children}</div>
}

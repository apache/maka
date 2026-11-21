/** 后台菜单（若依形制）。实现状态与 apps/admin 的 P 阶段对齐：done=有真页，todo=建设中占位。 */
export interface MenuItem {
  path: string;
  label: string;
  status: "done" | "todo";
  /** 打开该模块所需权限点（perms 含 "*" 的管理员不受限） */
  perm: string;
}

export const MENU: MenuItem[] = [
  { path: "/dashboard", label: "仪表盘", status: "done", perm: "" },
  { path: "/users", perm: "system:user:list", label: "用户管理", status: "done" },
  { path: "/roles", perm: "system:role:list", label: "角色管理", status: "done" },
  { path: "/menus", perm: "system:menu:list", label: "菜单管理", status: "done" },
  { path: "/depts", perm: "system:dept:list", label: "部门管理", status: "done" },
  { path: "/posts", perm: "system:post:list", label: "岗位管理", status: "done" },
  { path: "/dicts", perm: "system:dict:list", label: "字典管理", status: "done" },
  { path: "/configs", perm: "system:config:list", label: "参数设置", status: "done" },
  { path: "/notices", perm: "system:notice:list", label: "通知公告", status: "done" },
  { path: "/logs/oper", perm: "system:operlog:list", label: "操作日志", status: "done" },
  { path: "/logs/login", perm: "system:logininfor:list", label: "登录日志", status: "done" },
  { path: "/online", perm: "monitor:online:list", label: "在线用户", status: "done" },
  { path: "/jobs", perm: "monitor:job:list", label: "定时任务", status: "done" },
];

export const MENU_PATHS = new Set(MENU.map((m) => m.path));

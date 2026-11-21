/**
 * 数据层 —— node:sqlite + 若依核心表（SQLite 方言重建，字段对齐 liliya models.go）。
 * 与 Go 版的差异：存量 MySQL 库在 Mac 不存在，改为自建空库 + 种子 admin；
 * 密码算法形制保留 md5(loginName+password+salt)（见 reset-seed 的存量口径）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const DATA_DIR = process.env.ADMIN_DATA_DIR ?? path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'admin.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const g = globalThis as typeof globalThis & { __adminDb?: DatabaseSync };

function openDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  ensureSchema(db);
  seed(db);
  seedMenus(db);
  return db;
}

const DDL = `
CREATE TABLE IF NOT EXISTS sys_dept (
  dept_id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT 0,
  ancestors TEXT NOT NULL DEFAULT '', dept_name TEXT NOT NULL, order_num INTEGER NOT NULL DEFAULT 0,
  leader TEXT, phone TEXT, email TEXT, status TEXT NOT NULL DEFAULT '0',
  del_flag TEXT NOT NULL DEFAULT '0', create_time TEXT
);
CREATE TABLE IF NOT EXISTS sys_user (
  user_id INTEGER PRIMARY KEY, dept_id INTEGER, login_name TEXT NOT NULL UNIQUE,
  user_name TEXT NOT NULL, user_type TEXT NOT NULL DEFAULT '00', email TEXT DEFAULT '',
  phonenumber TEXT DEFAULT '', sex TEXT DEFAULT '0', avatar TEXT,
  password TEXT NOT NULL, salt TEXT NOT NULL, status TEXT NOT NULL DEFAULT '0',
  del_flag TEXT NOT NULL DEFAULT '0', login_ip TEXT, login_date TEXT,
  create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_role (
  role_id INTEGER PRIMARY KEY, role_name TEXT NOT NULL, role_key TEXT NOT NULL,
  role_sort INTEGER NOT NULL DEFAULT 0, data_scope TEXT NOT NULL DEFAULT '1',
  status TEXT NOT NULL DEFAULT '0', del_flag TEXT NOT NULL DEFAULT '0', create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_menu (
  menu_id INTEGER PRIMARY KEY, menu_name TEXT NOT NULL, parent_id INTEGER NOT NULL DEFAULT 0,
  order_num INTEGER NOT NULL DEFAULT 0, path TEXT DEFAULT '', component TEXT,
  menu_type TEXT NOT NULL DEFAULT 'C', visible TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT '0', perms TEXT DEFAULT '', icon TEXT DEFAULT '#', create_time TEXT
);
CREATE TABLE IF NOT EXISTS sys_post (
  post_id INTEGER PRIMARY KEY, post_code TEXT NOT NULL, post_name TEXT NOT NULL,
  post_sort INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '0', create_time TEXT
);
CREATE TABLE IF NOT EXISTS sys_user_role (
  user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (user_id, role_id)
);
CREATE TABLE IF NOT EXISTS sys_role_menu (
  role_id INTEGER NOT NULL, menu_id INTEGER NOT NULL, PRIMARY KEY (role_id, menu_id)
);
CREATE TABLE IF NOT EXISTS sys_user_post (
  user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS sys_config (
  config_id INTEGER PRIMARY KEY AUTOINCREMENT, config_name TEXT NOT NULL,
  config_key TEXT NOT NULL UNIQUE, config_value TEXT NOT NULL DEFAULT '',
  config_type TEXT NOT NULL DEFAULT 'N', create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_notice (
  notice_id INTEGER PRIMARY KEY AUTOINCREMENT, notice_title TEXT NOT NULL,
  notice_type TEXT NOT NULL DEFAULT '1', notice_content BLOB, status TEXT NOT NULL DEFAULT '0',
  create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_logininfor (
  info_id INTEGER PRIMARY KEY AUTOINCREMENT, user_name TEXT DEFAULT '',
  ipaddr TEXT DEFAULT '', login_location TEXT DEFAULT '', browser TEXT DEFAULT '',
  os TEXT DEFAULT '', status TEXT NOT NULL DEFAULT '0', msg TEXT DEFAULT '', login_time TEXT
);
CREATE TABLE IF NOT EXISTS sys_oper_log (
  oper_id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '', business_type INTEGER DEFAULT 0,
  method TEXT DEFAULT '', request_method TEXT DEFAULT '', oper_name TEXT DEFAULT '',
  oper_url TEXT DEFAULT '', oper_ip TEXT DEFAULT '', oper_param TEXT DEFAULT NULL,
  json_result TEXT DEFAULT NULL, status INTEGER DEFAULT 0, error_msg TEXT DEFAULT NULL,
  oper_time TEXT DEFAULT NULL, cost_time INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sys_dict_type (
  dict_id INTEGER PRIMARY KEY AUTOINCREMENT, dict_name TEXT NOT NULL,
  dict_type TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT '0', create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_dict_data (
  dict_code INTEGER PRIMARY KEY AUTOINCREMENT, dict_sort INTEGER DEFAULT 0,
  dict_label TEXT DEFAULT '', dict_value TEXT DEFAULT '', dict_type TEXT NOT NULL DEFAULT '',
  css_class TEXT DEFAULT '', list_class TEXT DEFAULT '', is_default TEXT DEFAULT 'N',
  status TEXT NOT NULL DEFAULT '0', create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_job (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT NOT NULL, job_group TEXT NOT NULL DEFAULT 'DEFAULT',
  invoke_target TEXT NOT NULL DEFAULT 'noop', cron_expression TEXT DEFAULT '',
  misfire_policy TEXT DEFAULT '3', concurrent TEXT DEFAULT '1', status TEXT NOT NULL DEFAULT '0',
  create_time TEXT, remark TEXT
);
CREATE TABLE IF NOT EXISTS sys_job_log (
  job_log_id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT DEFAULT '', job_group TEXT DEFAULT '',
  invoke_target TEXT DEFAULT '', job_message TEXT DEFAULT '', status TEXT DEFAULT '0',
  exception_info TEXT DEFAULT '', create_time TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_dept ON sys_user(dept_id);
CREATE INDEX IF NOT EXISTS idx_logininfor_time ON sys_logininfor(login_time);
`;

function ensureSchema(db: DatabaseSync) {
  db.exec(DDL);
}

function seed(db: DatabaseSync) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM sys_user').get() as { n: number };
  if (has.n > 0) return;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const salt = randomBytes(4).toString('hex');
  db.exec(`INSERT INTO sys_dept (dept_id, parent_id, ancestors, dept_name, order_num, status, create_time) VALUES
    (100, 0, '0', 'liliya科技', 0, '0', '${now}'),
    (101, 100, '0,100', '研发部门', 1, '0', '${now}')`);
  // admin/admin123 —— md5(loginName+password+salt)，对齐存量 SysPasswordService 形制
  const password = createHash('md5').update(`admin${'admin123'}${salt}`).digest('hex');
  db.prepare(
    `INSERT INTO sys_user (user_id, dept_id, login_name, user_name, user_type, password, salt, status, create_time, remark)
     VALUES (1, 100, 'admin', '若依管理员', '00', ?, ?, '0', ?, '内置管理员，user_id=1 全通过（存量 isAdmin 语义）')`,
  ).run(password, salt, now);
  db.exec(`INSERT INTO sys_role (role_id, role_name, role_key, role_sort, status, create_time, remark) VALUES
    (1, '超级管理员', 'admin', 1, '0', '${now}', '内置角色'),
    (2, '普通角色', 'common', 2, '0', '${now}', NULL)`);
  db.exec("INSERT INTO sys_user_role (user_id, role_id) VALUES (1, 1)");
  db.exec(`INSERT INTO sys_config (config_name, config_key, config_value, config_type, create_time) VALUES
    ('主框架页-默认皮肤样式名称', 'sys.index.skinName', 'skin-blue', 'Y', '${now}'),
    ('用户管理-账号自助-是否开启', 'sys.account.selfService', 'false', 'Y', '${now}')`);
  db.exec(`INSERT INTO sys_dict_type (dict_name, dict_type, status, create_time, remark) VALUES
    ('系统开关', 'sys_yes_no', '0', '${now}', '系统是否列表项')`);
  db.exec(`INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, is_default, status, create_time) VALUES
    (1, '是', 'Y', 'sys_yes_no', 'Y', '0', '${now}'),
    (2, '否', 'N', 'sys_yes_no', 'N', '0', '${now}')`);
}

/** 菜单+权限串种子（对齐 Go 版 main.go 的 RequirePerm 权限点）；幂等：菜单表空才种。 */
export function seedMenus(db: DatabaseSync) {
  const has = db.prepare('SELECT COUNT(*) AS n FROM sys_menu').get() as { n: number };
  if (has.n > 0) return;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let seq = 1;
  const ins = db.prepare(
    "INSERT INTO sys_menu (menu_id, menu_name, parent_id, order_num, path, menu_type, perms, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const dir = (name: string, path: string) => { const id = seq++; ins.run(id, name, 0, seq, path, 'M', '', now); return id; };
  const item = (parent: number, name: string, path: string, perms: string) => { const id = seq++; ins.run(id, name, parent, seq, path, 'C', perms, now); return id; };
  const btn = (parent: number, name: string, perms: string) => { const id = seq++; ins.run(id, name, parent, seq, '', 'F', perms, now); return id; };

  const sys = dir('系统管理', 'system');
  const u = item(sys, '用户管理', '/users', 'system:user:list');
  btn(u, '用户查询', 'system:user:query'); btn(u, '用户新增', 'system:user:add'); btn(u, '用户修改', 'system:user:edit');
  btn(u, '用户删除', 'system:user:remove'); btn(u, '重置密码', 'system:user:resetPwd'); btn(u, '导出', 'system:user:export'); btn(u, '导入', 'system:user:import');
  const r = item(sys, '角色管理', '/roles', 'system:role:list');
  btn(r, '角色新增', 'system:role:add'); btn(r, '角色修改', 'system:role:edit'); btn(r, '角色删除', 'system:role:remove');
  const m = item(sys, '菜单管理', '/menus', 'system:menu:list');
  btn(m, '菜单新增', 'system:menu:add'); btn(m, '菜单修改', 'system:menu:edit'); btn(m, '菜单删除', 'system:menu:remove');
  const d = item(sys, '部门管理', '/depts', 'system:dept:list');
  btn(d, '部门新增', 'system:dept:add'); btn(d, '部门修改', 'system:dept:edit'); btn(d, '部门删除', 'system:dept:remove');
  const p1 = item(sys, '岗位管理', '/posts', 'system:post:list');
  btn(p1, '岗位新增', 'system:post:add'); btn(p1, '岗位修改', 'system:post:edit'); btn(p1, '岗位删除', 'system:post:remove');
  const dt = item(sys, '字典管理', '/dicts', 'system:dict:list');
  btn(dt, '字典新增', 'system:dict:add'); btn(dt, '字典修改', 'system:dict:edit'); btn(dt, '字典删除', 'system:dict:remove');
  const cf = item(sys, '参数设置', '/configs', 'system:config:list');
  btn(cf, '参数新增', 'system:config:add'); btn(cf, '参数修改', 'system:config:edit'); btn(cf, '参数删除', 'system:config:remove');
  const nt = item(sys, '通知公告', '/notices', 'system:notice:list');
  btn(nt, '公告新增', 'system:notice:add'); btn(nt, '公告修改', 'system:notice:edit'); btn(nt, '公告删除', 'system:notice:remove');

  const mon = dir('系统监控', 'monitor');
  const ol = item(mon, '操作日志', '/logs/oper', 'system:operlog:list');
  btn(ol, '日志删除', 'system:operlog:remove');
  const ll = item(mon, '登录日志', '/logs/login', 'system:logininfor:list');
  btn(ll, '日志删除', 'system:logininfor:remove');
  item(mon, '在线用户', '/online', 'monitor:online:list');
  const j = item(mon, '定时任务', '/jobs', 'monitor:job:list');
  btn(j, '任务新增', 'monitor:job:add'); btn(j, '任务修改', 'monitor:job:edit'); btn(j, '任务删除', 'monitor:job:remove');
  btn(item(mon, '强制下线', '/online', 'monitor:online:list'), '强制下线按钮', 'monitor:online:forceLogout');

  // common 角色（role_id=2）授予部分权限点，供受限用户验证 403/200 分界
  const permRows = db.prepare("SELECT menu_id FROM sys_menu WHERE perms IN ('system:post:list','system:post:add','system:post:edit','system:post:remove','system:notice:list','system:notice:add')").all() as Array<{ menu_id: number }>;
  const assign = db.prepare('INSERT OR IGNORE INTO sys_role_menu (role_id, menu_id) VALUES (2, ?)');
  for (const row of permRows) assign.run(row.menu_id);
}

export function encryptPassword(loginName: string, password: string, salt: string): string {
  return createHash('md5').update(`${loginName}${password}${salt}`).digest('hex');
}

export const db = (g.__adminDb ??= openDb());

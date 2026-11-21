/** 登录态相关的固定文案与错误码 */

export const ERROR_MSG = {
  API_PERMISSION_DENIED: '没有该接口的访问权限',
  NOT_LOGIN: '登录已失效，请重新登录',
} as const;

/** 业务错误码约定 */
export const ERROR_CODE = {
  NOT_LOGIN: '4001',
} as const;

/** 业务错误码 → 提示文案（未收录的错误码直接透出后端 msg） */
export const BUSINESS_ERROR_MSG: Record<string, string> = {
  [ERROR_CODE.NOT_LOGIN]: ERROR_MSG.NOT_LOGIN,
};

/** 免权限校验的接口白名单 */
export const API_WHITELIST = ['/admin/user-info', '/admin/permission', '/admin/login'];

/**
 * 用户 API
 * 基于 user-DkQrGwhA.js 逆向分析
 */

import { getApiClient } from './baseRequest'
import type {
  LoginResponse,
  GetConfigResponse,
  UpdateConfigResponse,
  ApiResponse
} from '../types/api'
import type {
  LoginRequest,
  PhoneLoginRequest,
  SendCodeRequest,
  BindPhoneRequest,
  VerifyPasswordRequest,
  VerifyEmailRequest,
  UpdateUserRequest,
  UpdatePasswordRequest,
  RegistryRequest
} from '../types/api'

/**
 * 用户登录
 */
export async function login(
  params?: LoginRequest
): Promise<LoginResponse> {
  const client = getApiClient()
  return client.get('/user/login', { params })
}

/**
 * 获取用户信息
 */
export async function getUserInfo(): Promise<LoginResponse> {
  const client = getApiClient()
  return client.get('/user/info')
}

/**
 * 发送手机验证码
 */
export async function sendPhoneCode(
  data: SendCodeRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/send-phone-code', data)
}

/**
 * 手机验证码登录
 */
export async function phoneLogin(
  data: PhoneLoginRequest
): Promise<LoginResponse> {
  const client = getApiClient()
  return client.post('/user/phone-login', data)
}

/**
 * 绑定手机号
 */
export async function bindPhone(
  data: BindPhoneRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/bind-phone', data)
}

/**
 * 验证密码
 */
export async function verifyPassword(
  data: VerifyPasswordRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/verify-password', data)
}

/**
 * 验证邮箱
 */
export async function verifyEmail(
  data: VerifyEmailRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/verify-email', data)
}

/**
 * 更新用户信息
 */
export async function updateUser(
  data: UpdateUserRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/update', data)
}

/**
 * 更新用户详细信息
 */
export async function updateUserInfo(
  data: UpdateUserRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/updateinfo', data)
}

/**
 * 修改密码
 */
export async function updatePassword(
  data: UpdatePasswordRequest
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/updatePass', data)
}

/**
 * 删除账号
 */
export async function deleteAccount(): Promise<ApiResponse> {
  const client = getApiClient()
  return client.delete('/user/deleteOne')
}

/**
 * 用户注册
 */
export async function registry(
  data: RegistryRequest
): Promise<LoginResponse> {
  const client = getApiClient()
  return client.post('/user/registry', data)
}

/**
 * 发送验证码 (邮箱)
 */
export async function sendVerifyCode(
  data: { email: string }
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/sendVerifyCode', data)
}

/**
 * 手机号设置密码
 */
export async function phoneSetPassword(
  data: { phone: string; password: string; code: string }
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/phone-setpassword', data)
}

/**
 * 微信绑定手机
 */
export async function wechatBindPhone(
  data: { phone: string; code: string }
): Promise<ApiResponse> {
  const client = getApiClient()
  return client.post('/user/wechat-bind-phone', data)
}

// ==================== 配置 API ====================

/**
 * 获取用户配置
 */
export async function getConfig(): Promise<GetConfigResponse> {
  const client = getApiClient()
  return client.get('/itab/config')
}

/**
 * 更新用户配置
 */
export async function updateConfig(
  config: any
): Promise<UpdateConfigResponse> {
  const client = getApiClient()
  return client.post('/itab/update', config)
}

// ==================== 导出 ====================

export const userApi = {
  login,
  getUserInfo,
  sendPhoneCode,
  phoneLogin,
  bindPhone,
  verifyPassword,
  verifyEmail,
  updateUser,
  updateUserInfo,
  updatePassword,
  deleteAccount,
  registry,
  sendVerifyCode,
  phoneSetPassword,
  wechatBindPhone,
  getConfig,
  updateConfig
}

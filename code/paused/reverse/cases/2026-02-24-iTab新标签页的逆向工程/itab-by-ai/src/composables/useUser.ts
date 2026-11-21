/**
 * useUser - 用户状态管理组合式函数
 *
 * 功能:
 * - 用户登录/登出
 * - Token 管理
 * - 用户信息获取
 * - 配置同步
 */

import { ref, computed } from 'vue'
import type { Ref } from 'vue'
import type { UserInfo, AppConfig } from '../types'
import { userApi } from '../api'
import indexdb from '../storage/indexdb'
import localStorage from '../storage/localStorage'

// ==================== 状态 ====================

/**
 * 当前用户信息
 */
const currentUser = ref<UserInfo | null>(null)

/**
 * Token
 */
const token = ref<string | null>(null)

/**
 * 是否已登录
 */
const isLoggedIn = computed(() => !!token.value && !!currentUser.value)

/**
 * 用户配置
 */
const userConfig = ref<AppConfig | null>(null)

// ==================== 核心功能 ====================

/**
 * 用户管理 Hook
 */
export function useUser() {
  // ==================== 初始化 ====================

  /**
   * 初始化用户状态
   */
  async function initUser() {
    // 从本地存储加载 token
    const savedToken = localStorage.get('token')
    if (savedToken) {
      token.value = savedToken
      // 获取用户信息
      await fetchUserInfo()
    }

    // 加载用户配置
    await loadUserConfig()
  }

  // ==================== 登录/登出 ====================

  /**
   * 用户登录
   */
  async function login(params: {
    phone?: string
    password?: string
    email?: string
    code?: string
  }): Promise<boolean> {
    try {
      let response

      // 手机验证码登录
      if (params.phone && params.code) {
        response = await userApi.phoneLogin({
          phone: params.phone,
          code: params.code
        })
      }
      // 账号密码登录
      else {
        response = await userApi.login({
          phone: params.phone,
          email: params.email,
          password: params.password
        })
      }

      if (response.code === 200 && response.data) {
        const { token: newToken, userInfo } = response.data
        token.value = newToken
        currentUser.value = userInfo

        // 保存 token
        localStorage.set('token', newToken)

        // 同步配置
        await syncConfigFromServer()

        return true
      }

      return false
    } catch (error) {
      console.error('登录失败:', error)
      return false
    }
  }

  /**
   * 用户登出
   */
  async function logout() {
    token.value = null
    currentUser.value = null
    localStorage.remove('token')
  }

  // ==================== 用户信息 ====================

  /**
   * 获取用户信息
   */
  async function fetchUserInfo(): Promise<UserInfo | null> {
    try {
      const response = await userApi.getUserInfo()

      if (response.code === 200 && response.data) {
        currentUser.value = response.data
        return response.data
      }
    } catch (error) {
      console.error('获取用户信息失败:', error)
    }
    return null
  }

  /**
   * 更新用户信息
   */
  async function updateUserInfo(data: {
    avatar?: string
    nickname?: string
  }): Promise<boolean> {
    try {
      const response = await userApi.updateUser(data)

      if (response.code === 200) {
        // 刷新用户信息
        await fetchUserInfo()
        return true
      }
    } catch (error) {
      console.error('更新用户信息失败:', error)
    }
    return false
  }

  /**
   * 修改密码
   */
  async function changePassword(params: {
    oldPassword: string
    newPassword: string
  }): Promise<boolean> {
    try {
      const response = await userApi.updatePassword({
        oldPass: params.oldPassword,
        newPass: params.newPassword
      })

      return response.code === 200
    } catch (error) {
      console.error('修改密码失败:', error)
      return false
    }
  }

  /**
   * 删除账号
   */
  async function deleteAccount(): Promise<boolean> {
    try {
      const response = await userApi.deleteAccount()
      if (response.code === 200) {
        await logout()
        return true
      }
    } catch (error) {
      console.error('删除账号失败:', error)
    }
    return false
  }

  // ==================== 验证码 ====================

  /**
   * 发送手机验证码
   */
  async function sendPhoneCode(phone: string): Promise<boolean> {
    try {
      const response = await userApi.sendPhoneCode({ phone })
      return response.code === 200
    } catch (error) {
      console.error('发送验证码失败:', error)
      return false
    }
  }

  /**
   * 发送邮箱验证码
   */
  async function sendEmailCode(email: string): Promise<boolean> {
    try {
      const response = await userApi.sendVerifyCode({ email })
      return response.code === 200
    } catch (error) {
      console.error('发送验证码失败:', error)
      return false
    }
  }

  // ==================== 配置同步 ====================

  /**
   * 从服务器同步配置
   */
  async function syncConfigFromServer(): Promise<AppConfig | null> {
    if (!isLoggedIn.value) return null

    try {
      const response = await userApi.getConfig()

      if (response.code === 200 && response.data) {
        userConfig.value = response.data
        // 保存到本地
        await saveUserConfig(response.data)
        return response.data
      }
    } catch (error) {
      console.error('同步配置失败:', error)
    }
    return null
  }

  /**
   * 上传配置到服务器
   */
  async function uploadConfigToServer(config: Partial<AppConfig>): Promise<boolean> {
    if (!isLoggedIn.value) return false

    try {
      const response = await userApi.updateConfig(config)
      return response.code === 200
    } catch (error) {
      console.error('上传配置失败:', error)
      return false
    }
  }

  /**
   * 加载用户配置
   */
  async function loadUserConfig(): Promise<void> {
    const config = await indexdb.get<AppConfig>('user-config')
    if (config) {
      userConfig.value = config
    }
  }

  /**
   * 保存用户配置
   */
  async function saveUserConfig(config: AppConfig): Promise<void> {
    userConfig.value = config
    await indexdb.set('user-config', config)

    // 如果已登录，同步到服务器
    if (isLoggedIn.value) {
      await uploadConfigToServer(config)
    }
  }

  /**
   * 更新配置
   */
  async function updateConfig(config: Partial<AppConfig>): Promise<void> {
    const newConfig = { ...userConfig.value, ...config } as AppConfig
    await saveUserConfig(newConfig)
  }

  // ==================== 计算属性 ====================

  /**
   * 用户头像
   */
  const avatar = computed(() => currentUser.value?.avatar || '')

  /**
   * 用户昵称
   */
  const nickname = computed(() => currentUser.value?.nickname || '用户')

  /**
   * 用户手机号
   */
  const phone = computed(() => currentUser.value?.phone || '')

  /**
   * 用户邮箱
   */
  const email = computed(() => currentUser.value?.email || '')

  // ==================== 返回 ====================

  return {
    // 状态
    currentUser,
    token,
    isLoggedIn,
    userConfig,

    // 计算属性
    avatar,
    nickname,
    phone,
    email,

    // 方法
    initUser,
    login,
    logout,
    fetchUserInfo,
    updateUserInfo,
    changePassword,
    deleteAccount,
    sendPhoneCode,
    sendEmailCode,
    syncConfigFromServer,
    uploadConfigToServer,
    loadUserConfig,
    saveUserConfig,
    updateConfig
  }
}

<template>
  <div class="popup-container">
    <!-- 头部 -->
    <header class="popup-header">
      <h1 class="popup-title">iTab 设置</h1>
    </header>

    <!-- 内容 -->
    <main class="popup-content">
      <!-- 用户信息 -->
      <section v-if="isLoggedIn" class="popup-section">
        <div class="user-info">
          <img :src="userInfo.avatar" class="user-avatar" alt="avatar" />
          <div class="user-details">
            <div class="user-name">{{ userInfo.nickname || '用户' }}</div>
            <div class="user-phone">{{ userInfo.phone || userInfo.email }}</div>
          </div>
          <button class="btn btn-secondary" @click="handleLogout">
            退出登录
          </button>
        </div>
      </section>

      <!-- 未登录状态 -->
      <section v-else class="popup-section">
        <div class="login-prompt">
          <p>登录后可同步配置到云端</p>
          <button class="btn btn-primary" @click="handleLogin">
            立即登录
          </button>
        </div>
      </section>

      <!-- 快捷操作 -->
      <section class="popup-section">
        <h2 class="section-title">快捷操作</h2>
        <div class="action-grid">
          <button class="action-btn" @click="handleSwitchWallpaper">
            <span class="action-icon">🖼️</span>
            <span class="action-text">切换壁纸</span>
          </button>
          <button class="action-btn" @click="handleExportConfig">
            <span class="action-icon">📤</span>
            <span class="action-text">导出配置</span>
          </button>
          <button class="action-btn" @click="handleImportConfig">
            <span class="action-icon">📥</span>
            <span class="action-text">导入配置</span>
          </button>
          <button class="action-btn" @click="handleOpenSettings">
            <span class="action-icon">⚙️</span>
            <span class="action-text">更多设置</span>
          </button>
        </div>
      </section>

      <!-- 数据统计 -->
      <section class="popup-section">
        <h2 class="section-title">数据统计</h2>
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-value">{{ stats.iconCount }}</div>
            <div class="stat-label">图标数量</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">{{ stats.groupCount }}</div>
            <div class="stat-label">分组数量</div>
          </div>
        </div>
      </section>
    </main>

    <!-- 底部 -->
    <footer class="popup-footer">
      <span class="version">版本 {{ version }}</span>
      <a href="https://itab.link" target="_blank" class="link">官网</a>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * Popup 弹窗组件
 *
 * 功能:
 * - 用户登录/登出
 * - 快捷操作
 * - 配置导入/导出
 */

import { ref, computed, onMounted } from 'vue'
import { useUser } from '../composables/useUser'
import { useConfig } from '../composables/useConfig'
import { useWallpaper } from '../composables/useWallpaper'

// ==================== 状态 ====================

const version = chrome.runtime.getManifest().version

// ==================== Composables ====================

const { isLoggedIn, userInfo, logout } = useUser()
const { navConfig, exportConfig, importConfig } = useConfig()
const { switchWallpaper } = useWallpaper()

// ==================== 计算属性 ====================

/**
 * 数据统计
 */
const stats = computed(() => {
  const groups = navConfig.value.navGroups || []
  let iconCount = 0

  for (const group of groups) {
    if (group.children) {
      iconCount += group.children.length
    }
  }

  return {
    iconCount,
    groupCount: groups.length
  }
})

// ==================== 方法 ====================

/**
 * 处理登录
 */
function handleLogin() {
  // 打开登录页面
  chrome.tabs.create({ url: 'https://itab.link/login' })
}

/**
 * 处理登出
 */
async function handleLogout() {
  await logout()
  window.close()
}

/**
 * 切换壁纸
 */
async function handleSwitchWallpaper() {
  await switchWallpaper()
}

/**
 * 导出配置
 */
async function handleExportConfig() {
  try {
    const json = await exportConfig()

    // 创建下载
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `itab-config-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('导出配置失败:', error)
    alert('导出配置失败')
  }
}

/**
 * 导入配置
 */
function handleImportConfig() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json'

  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const success = await importConfig(text)

      if (success) {
        alert('导入配置成功')
      } else {
        alert('导入配置失败')
      }
    } catch (error) {
      console.error('导入配置失败:', error)
      alert('导入配置失败')
    }
  }

  input.click()
}

/**
 * 打开完整设置页面
 */
function handleOpenSettings() {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') })
}

// ==================== 生命周期 ====================

onMounted(() => {
  console.log('Popup mounted')
})
</script>

<style scoped>
.popup-container {
  width: 400px;
  max-height: 600px;
  background: #f5f5f5;
  display: flex;
  flex-direction: column;
}

.popup-header {
  padding: 16px 20px;
  background: white;
  border-bottom: 1px solid #e5e5e5;
}

.popup-title {
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.popup-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.popup-section {
  margin-bottom: 20px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #666;
  margin-bottom: 12px;
}

/* 用户信息 */
.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: white;
  border-radius: 8px;
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
}

.user-details {
  flex: 1;
}

.user-name {
  font-size: 16px;
  font-weight: 500;
  color: #333;
}

.user-phone {
  font-size: 12px;
  color: #999;
}

.login-prompt {
  padding: 20px;
  text-align: center;
  background: white;
  border-radius: 8px;
}

.login-prompt p {
  font-size: 14px;
  color: #666;
  margin-bottom: 12px;
}

/* 快捷操作 */
.action-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  background: white;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: #f9f9f9;
  border-color: #3b82f6;
}

.action-icon {
  font-size: 24px;
}

.action-text {
  font-size: 12px;
  color: #666;
}

/* 数据统计 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.stat-item {
  padding: 16px;
  background: white;
  border-radius: 8px;
  text-align: center;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #3b82f6;
}

.stat-label {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

/* 底部 */
.popup-footer {
  padding: 12px 20px;
  background: white;
  border-top: 1px solid #e5e5e5;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.version {
  font-size: 12px;
  color: #999;
}

.link {
  font-size: 12px;
  color: #3b82f6;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

/* 按钮样式 */
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background: #3b82f6;
  color: white;
}

.btn-primary:hover {
  background: #2563eb;
}

.btn-secondary {
  background: #f5f5f5;
  color: #666;
}

.btn-secondary:hover {
  background: #e5e5e5;
}
</style>

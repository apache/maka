<template>
  <div class="app-container">
    <!-- 壁纸背景 -->
    <Wallpaper />
    <div class="wallpaper-mask" :style="maskStyle" />

    <!-- 头部区域 -->
    <header class="app-header" :class="{ 'has-search': showSearch }">
      <!-- 时间组件 -->
      <DateWidget v-if="config.time.show" />

      <!-- 搜索框 -->
      <div v-if="showSearch" class="search-box">
        <div class="search-input-wrapper">
          <img
            :src="searchIconUrl"
            class="search-icon"
            alt="search"
          />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="text"
            class="search-input"
            :placeholder="searchPlaceholder"
            @keypress.enter="handleSearch"
            @focus="isSearchFocused = true"
            @blur="isSearchFocused = false"
          />
          <button
            v-if="searchQuery"
            class="search-button clear-btn"
            @click="searchQuery = ''"
          >
            ✕
          </button>
          <button
            v-else
            class="search-button"
            @click="handleSearch"
          >
            🔍
          </button>
        </div>

        <!-- 搜索建议 -->
        <div
          v-if="showSearchSuggestions && isSearchFocused"
          class="search-suggestions"
        >
          <div
            v-for="(suggestion, index) in searchSuggestions"
            :key="index"
            class="suggestion-item"
            @click="selectSuggestion(suggestion)"
          >
            {{ suggestion }}
          </div>
        </div>
      </div>
    </header>

    <!-- 主内容区 -->
    <main class="app-main">
      <!-- 图标网格 -->
      <div v-if="config.icon.show" class="icon-grid">
        <!-- 渲染导航组 -->
        <div
          v-for="group in navGroups"
          :key="group.id"
          class="nav-group"
        >
          <!-- 导航组标题 -->
          <div
            v-if="group.name && navGroups.length > 1"
            class="nav-group-header"
          >
            <span class="nav-group-icon">📁</span>
            <span class="nav-group-title">{{ group.name }}</span>
          </div>

          <!-- 导航组图标 -->
          <div class="nav-group-icons">
            <a
              v-for="icon in group.children"
              :key="icon.id"
              :href="icon.url"
              class="icon-item"
              :title="icon.name"
            >
              <div class="icon-item-icon" :style="iconStyle(icon)">
                <img
                  v-if="icon.src"
                  :src="icon.src"
                  :alt="icon.name"
                />
                <span v-else>{{ icon.iconText || icon.name?.slice(0, 2) }}</span>
              </div>
              <span class="icon-item-name">{{ icon.name }}</span>
            </a>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <span class="empty-icon">📭</span>
        <span class="empty-text">暂无图标</span>
      </div>
    </main>

    <!-- 底部状态栏 -->
    <footer class="status-bar">
      <div class="status-bar-left">
        <!-- 天气组件 -->
        <WeatherWidget :show-location="false" :show-sun-time="false" />

        <!-- 一言 -->
        <span v-if="config.layout.yiyan && yiyan" class="yiyan">
          「 {{ yiyan.hitokoto }} 」
        </span>
      </div>

      <div class="status-bar-right">
        <!-- 布局切换按钮 -->
        <button
          class="btn-icon"
          :title="`切换到${config.layout.view === 'widget' ? '简洁' : '组件'}模式`"
          @click="toggleLayoutView"
        >
          {{ config.layout.view === 'widget' ? '📊' : '📱' }}
        </button>

        <!-- 设置按钮 -->
        <button
          class="btn-icon"
          title="设置"
          @click="openSettings"
        >
          ⚙️
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
/**
 * App 根组件
 *
 * 功能:
 * - 整合所有子组件
 * - 管理全局布局
 * - 处理搜索功能
 */

import { ref, computed, onMounted, watch } from 'vue'
import { useConfig } from '../composables/useConfig'
import { useWallpaper } from '../composables/useWallpaper'
import { useWeather } from '../composables/useWeather'
import { getWebsiteIcon, generateId } from '../utils'
import type { IconItem, NavGroup, SearchEngine } from '../types'

// ==================== 组件导入 ====================

import Wallpaper from './Wallpaper.vue'
import DateWidget from './DateWidget.vue'
import WeatherWidget from './WeatherWidget.vue'

// ==================== 状态 ====================

const searchInputRef = ref<HTMLInputElement>()
const searchQuery = ref('')
const isSearchFocused = ref(false)
const yiyan = ref<{ hitokoto: string; from: string } | null>(null)

// ==================== Composables ====================

const { baseConfig: config, navConfig, searchEngines, updateBaseConfig } = useConfig()
const { currentWallpaper } = useWallpaper()
const { currentWeather } = useWeather()

// ==================== 计算属性 ====================

/**
 * 是否显示搜索框
 */
const showSearch = computed(() => config.value.search.show)

/**
 * 搜索图标 URL
 */
const searchIconUrl = computed(() => {
  const engine = searchEngines.value.find(e => e.key === config.value.search.default)
  return engine?.icon || 'https://files.codelife.cc/itab/search/baidu.svg'
})

/**
 * 搜索占位符
 */
const searchPlaceholder = computed(() => {
  const engine = searchEngines.value.find(e => e.key === config.value.search.default)
  return `搜索${engine?.title || '百度'}...`
})

/**
 * 导航组列表
 */
const navGroups = computed(() => navConfig.value.navGroups)

/**
 * 遮罩样式
 */
const maskStyle = computed(() => ({
  backgroundColor: `rgba(0, 0, 0, ${currentWallpaper.value.mask})`
}))

/**
 * 搜索建议
 */
const searchSuggestions = computed(() => {
  if (!searchQuery.value) return []

  const suggestions = [
    searchQuery.value,
    `${searchQuery.value} 教程`,
    `${searchQuery.value} 官网`,
    `${searchQuery.value} 下载`
  ]

  return suggestions.slice(0, 5)
})

/**
 * 是否显示搜索建议
 */
const showSearchSuggestions = computed(() => {
  return searchSuggestions.value.length > 0
})

// ==================== 方法 ====================

/**
 * 获取图标样式
 */
function iconStyle(icon: IconItem) {
  const style: Record<string, string> = {}

  if (icon.backgroundColor) {
    style.backgroundColor = icon.backgroundColor
  }

  return style
}

/**
 * 处理搜索
 */
function handleSearch() {
  if (!searchQuery.value.trim()) return

  const engine = searchEngines.value.find(
    e => e.key === config.value.search.default
  )

  if (engine) {
    const url = engine.href + encodeURIComponent(searchQuery.value)
    window.open(url, '_blank')
  }
}

/**
 * 选择搜索建议
 */
function selectSuggestion(suggestion: string) {
  searchQuery.value = suggestion
  handleSearch()
}

/**
 * 切换布局视图
 */
function toggleLayoutView() {
  updateBaseConfig({
    layout: {
      ...config.value.layout,
      view: config.value.layout.view === 'widget' ? 'simple' : 'widget'
    }
  })
}

/**
 * 打开设置
 */
function openSettings() {
  // 打开 popup
  chrome.runtime.openOptionsPage?.() ||
  chrome.tabs.create({ url: 'popup.html' })
}

/**
 * 加载一言
 */
async function loadYiyan() {
  try {
    const response = await fetch('https://api.codelife.cc/yiyan')
    const data = await response.json()

    if (data.code === 200 && data.data) {
      yiyan.value = {
        hitokoto: data.data.hitokoto,
        from: data.data.from
      }
    }
  } catch (error) {
    console.error('加载一言失败:', error)
  }
}

// ==================== 生命周期 ====================

onMounted(() => {
  // 自动聚焦搜索框
  if (searchInputRef.value && showSearch.value) {
    setTimeout(() => {
      searchInputRef.value?.focus()
    }, 100)
  }

  // 加载一言
  if (config.value.layout.yiyan) {
    loadYiyan()
  }
})
</script>

<style scoped>
@import '../styles/global.css';
@import '../styles/components.css';

.wallpaper-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 0;
  backdrop-filter: blur(var(--wall-blur));
  -webkit-backdrop-filter: blur(var(--wall-blur));
}

.app-main {
  flex: 1;
  overflow-y: auto;
  position: relative;
  z-index: 10;
}

.search-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 8px;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
}

.suggestion-item {
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.2s ease;
  color: #333;
}

.suggestion-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.yiyan {
  font-size: 12px;
  opacity: 0.7;
  cursor: pointer;
}

.yiyan:hover {
  opacity: 0.9;
}

.clear-btn {
  font-size: 14px;
}
</style>

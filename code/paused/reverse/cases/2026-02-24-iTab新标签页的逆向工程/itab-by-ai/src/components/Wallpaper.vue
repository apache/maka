<template>
  <div class="wallpaper-container">
    <!-- 壁纸背景 -->
    <div
      ref="wallpaperRef"
      class="wallpaper-bg"
      :class="{ 'is-loading': isLoading }"
      :style="wallpaperStyle"
    />

    <!-- 遮罩层 -->
    <div
      class="wallpaper-mask"
      :style="maskStyle"
    />

    <!-- 切换按钮 -->
    <button
      v-if="currentWallpaper.switchBtn"
      class="wallpaper-switch-btn"
      @click="handleSwitch"
      :disabled="isLoading"
    >
      <span class="icon">🔄</span>
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * Wallpaper 壁纸组件
 *
 * 功能:
 * - 显示壁纸
 * - 支持图片/视频/纯色背景
 * - 遮罩和模糊效果
 * - 切换壁纸
 */

import { computed, ref, onMounted, watch } from 'vue'
import { useWallpaper } from '../composables/useWallpaper'
import type { Wallpaper } from '../types'

// ==================== Props ====================

interface Props {
  wallpaper?: Wallpaper
  autoLoad?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  autoLoad: true
})

// ==================== Emits ====================

interface Emits {
  (e: 'load', wallpaper: Wallpaper): void
  (e: 'error', error: Error): void
}

const emit = defineEmits<Emits>()

// ==================== Composables ====================

const {
  currentWallpaper,
  isLoading,
  getRandomWallpaper,
  switchWallpaper
} = useWallpaper()

// ==================== 状态 ====================

const wallpaperRef = ref<HTMLElement>()

// ==================== 计算属性 ====================

/**
 * 壁纸样式
 */
const wallpaperStyle = computed(() => {
  const wallpaper = props.wallpaper || currentWallpaper.value

  switch (wallpaper.type) {
    case 0: // 内置壁纸
    case 1: // 图片壁纸
    case 4: // Unsplash
      return {
        backgroundImage: `url(${wallpaper.src})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }

    case 2: // 视频壁纸
      return {
        backgroundImage: 'none'
      }

    case 3: // 纯色背景
      return {
        backgroundImage: 'none',
        backgroundColor: wallpaper.src
      }

    default:
      return {}
  }
})

/**
 * 遮罩样式
 */
const maskStyle = computed(() => {
  const wallpaper = props.wallpaper || currentWallpaper.value
  const alpha = Math.round(wallpaper.mask * 255).toString(16).padStart(2, '0')
  return {
    backgroundColor: `rgba(0, 0, 0, ${wallpaper.mask})`
  }
})

// ==================== 方法 ====================

/**
 * 加载壁纸
 */
async function loadWallpaper() {
  try {
    if (props.wallpaper) {
      currentWallpaper.value = props.wallpaper
    }

    if (!currentWallpaper.value.src) {
      await getRandomWallpaper()
    }

    emit('load', currentWallpaper.value)
  } catch (error) {
    emit('error', error as Error)
  }
}

/**
 * 切换壁纸
 */
async function handleSwitch() {
  await switchWallpaper()
}

/**
 * 应用壁纸到 DOM
 */
function applyWallpaper() {
  const wallpaper = props.wallpaper || currentWallpaper.value
  const el = wallpaperRef.value
  if (!el) return

  // 清除视频
  const existingVideo = el.querySelector('video')
  if (existingVideo) {
    existingVideo.remove()
  }

  // 添加视频（如果是视频壁纸）
  if (wallpaper.type === 2 && wallpaper.src) {
    const video = document.createElement('video')
    video.className = 'wallpaper-video'
    video.autoplay = true
    video.muted = true
    video.loop = true
    video.poster = wallpaper.thumb || ''
    video.src = wallpaper.src
    el.appendChild(video)
  }
}

// ==================== 监听 ====================

watch(() => props.wallpaper, () => {
  applyWallpaper()
})

// ==================== 生命周期 ====================

onMounted(() => {
  if (props.autoLoad) {
    loadWallpaper()
  }
  applyWallpaper()
})
</script>

<style scoped>
.wallpaper-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 0;
  overflow: hidden;
}

.wallpaper-bg {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  transition: background 0.3s ease, transform 0.3s ease;
}

.wallpaper-bg.is-loading {
  transform: scale(1.1);
}

.wallpaper-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  backdrop-filter: blur(var(--wall-blur, 0px));
  -webkit-backdrop-filter: blur(var(--wall-blur, 0px));
}

.wallpaper-video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wallpaper-switch-btn {
  position: absolute;
  bottom: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  z-index: 10;
}

.wallpaper-switch-btn:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: scale(1.1);
}

.wallpaper-switch-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wallpaper-switch-btn .icon {
  font-size: 20px;
}
</style>

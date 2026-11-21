/**
 * useWallpaper - 壁纸管理组合式函数
 *
 * 功能:
 * - 壁纸加载和切换
 * - 壁纸类型处理 (图片/视频/纯色/Unsplash)
 * - 壁纸主色调提取
 * - 壁纸使用记录
 */

import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import type { Wallpaper, WallpaperType, WallpaperItem } from '../types'
import { wallpaperApi } from '../api'
import indexdb from '../storage/indexdb'

// ==================== 状态 ====================

/**
 * 当前壁纸配置
 */
const currentWallpaper = ref<Wallpaper>({
  type: 0,
  src: '',
  thumb: '',
  mask: 0.3,
  blur: 0,
  switchBtn: false
})

/**
 * 壁纸加载状态
 */
const isLoading = ref(false)

/**
 * 壁纸列表
 */
const wallpaperList = ref<WallpaperItem[]>([])

/**
 * 当前分类
 */
const currentCategory = ref('')

// ==================== 核心功能 ====================

/**
 * 壁纸管理 Hook
 */
export function useWallpaper() {
  // ==================== 壁纸加载 ====================

  /**
   * 加载壁纸列表
   */
  async function loadWallpaperList(category: string, page = 1) {
    try {
      const response = await wallpaperApi.getWallpaperList({
        category,
        page,
        pageSize: 20
      })

      if (response.code === 200 && response.data) {
        wallpaperList.value = response.data.list || []
      }
    } catch (error) {
      console.error('加载壁纸列表失败:', error)
    }
  }

  /**
   * 获取随机壁纸
   */
  async function getRandomWallpaper(category?: string) {
    try {
      isLoading.value = true

      const response = await wallpaperApi.getRandomWallpaper({ category })

      if (response.code === 200 && response.data) {
        const { src, thumb } = response.data
        await setWallpaper({
          type: 1,
          src,
          thumb: thumb || src,
          mask: currentWallpaper.value.mask,
          blur: currentWallpaper.value.blur
        })

        // 记录使用
        if (response.data.id) {
          wallpaperApi.recordWallpaperUse(response.data.id)
        }
      }
    } catch (error) {
      console.error('获取随机壁纸失败:', error)
      // 失败时使用备用壁纸
      await loadFallbackWallpaper()
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 获取 Unsplash 壁纸
   */
  async function getUnsplashWallpaper(page = 1) {
    try {
      isLoading.value = true

      const response = await wallpaperApi.getUnsplashWallpaper({ page })

      if (response.code === 200 && response.data?.list?.[0]) {
        const wallpaper = response.data.list[0]
        await setWallpaper({
          type: 4,
          src: wallpaper.src,
          thumb: wallpaper.thumb,
          mask: currentWallpaper.value.mask,
          blur: currentWallpaper.value.blur
        })
      }
    } catch (error) {
      console.error('获取 Unsplash 壁纸失败:', error)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 加载备用壁纸
   */
  async function loadFallbackWallpaper() {
    const fallbackWallpapers = [
      'https://files.codelife.cc/wallpaper/default1.jpg',
      'https://files.codelife.cc/wallpaper/default2.jpg',
      'https://files.codelife.cc/wallpaper/default3.jpg'
    ]
    const randomIndex = Math.floor(Math.random() * fallbackWallpapers.length)

    await setWallpaper({
      type: 0,
      src: fallbackWallpapers[randomIndex],
      thumb: fallbackWallpapers[randomIndex],
      mask: currentWallpaper.value.mask,
      blur: currentWallpaper.value.blur
    })
  }

  // ==================== 壁纸设置 ====================

  /**
   * 设置壁纸
   */
  async function setWallpaper(wallpaper: Wallpaper) {
    currentWallpaper.value = { ...wallpaper }

    // 保存到本地存储
    await indexdb.set('current-wallpaper', wallpaper)

    // 如果是图片类型，提取主色调
    if (wallpaper.type === 0 || wallpaper.type === 1 || wallpaper.type === 4) {
      await extractMainColor(wallpaper.thumb || wallpaper.src)
    } else if (wallpaper.type === 3) {
      // 纯色背景
      applyColorTheme(wallpaper.src, '#233,233,233')
    }
  }

  /**
   * 设置壁纸类型
   */
  function setWallpaperType(type: WallpaperType) {
    currentWallpaper.value.type = type
  }

  /**
   * 设置遮罩
   */
  function setMask(mask: number) {
    currentWallpaper.value.mask = Math.max(0, Math.min(1, mask))
    saveWallpaper()
  }

  /**
   * 设置模糊
   */
  function setBlur(blur: number) {
    currentWallpaper.value.blur = Math.max(0, Math.min(20, blur))
    saveWallpaper()
  }

  /**
   * 保存壁纸配置
   */
  async function saveWallpaper() {
    await indexdb.set('current-wallpaper', currentWallpaper.value)
  }

  // ==================== 主色调提取 ====================

  /**
   * 提取图片主色调
   */
  async function extractMainColor(imageUrl: string): Promise<string | null> {
    try {
      // 加载图片
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = imageUrl

      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = reject
      })

      // 使用 Canvas 提取颜色
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      canvas.width = 1
      canvas.height = 1
      ctx.drawImage(img, 0, 0, 1, 1)

      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data

      // 判断明暗
      const brightness = (r * 299 + g * 587 + b * 114) / 1000
      const textColor = brightness > 128 ? '0,0,0' : '233,233,233'

      applyColorTheme(`${r},${g},${b}`, textColor)

      return `${r},${g},${b}`
    } catch (error) {
      console.error('提取主色调失败:', error)
      return null
    }
  }

  /**
   * 应用颜色主题
   */
  function applyColorTheme(bgColor: string, textColor: string) {
    document.body.style.setProperty('--img-bg', bgColor)
    document.body.style.setProperty('--img-text', textColor)

    // 保存到本地存储
    localStorage.setItem('sidebarColor', JSON.stringify({
      bg: bgColor,
      text: textColor
    }))
  }

  // ==================== 壁纸操作 ====================

  /**
   * 切换壁纸
   */
  async function switchWallpaper() {
    if (currentWallpaper.value.type === 2) {
      // 视频壁纸暂不支持切换
      return
    }

    await getRandomWallpaper(currentCategory.value)
  }

  /**
   * 点赞壁纸
   */
  async function likeWallpaper(id: string) {
    try {
      await wallpaperApi.likeWallpaper({ id })
    } catch (error) {
      console.error('点赞失败:', error)
    }
  }

  // ==================== 初始化 ====================

  /**
   * 初始化壁纸
   */
  async function initWallpaper() {
    // 从本地存储加载壁纸配置
    const saved = await indexdb.get<Wallpaper>('current-wallpaper')
    if (saved) {
      currentWallpaper.value = saved
    }

    // 如果没有壁纸，加载默认壁纸
    if (!currentWallpaper.value.src) {
      await loadFallbackWallpaper()
    } else {
      // 恢复壁纸显示
      applyWallpaperToDOM(currentWallpaper.value)
    }
  }

  /**
   * 将壁纸应用到 DOM
   */
  function applyWallpaperToDOM(wallpaper: Wallpaper) {
    const wallpaperEl = document.querySelector('.wallpaper') as HTMLElement
    if (!wallpaperEl) return

    // 移除旧的壁纸
    wallpaperEl.style.backgroundImage = ''
    wallpaperEl.style.backgroundColor = ''
    const oldVideo = wallpaperEl.querySelector('video')
    if (oldVideo) oldVideo.remove()

    // 应用新壁纸
    if (wallpaper.type === 3) {
      // 纯色背景
      wallpaperEl.style.backgroundColor = wallpaper.src
    } else if (wallpaper.type === 2) {
      // 视频壁纸
      const video = document.createElement('video')
      video.className = 'wallpaper-video'
      video.autoplay = true
      video.muted = true
      video.loop = true
      video.poster = wallpaper.thumb
      video.src = wallpaper.src
      wallpaperEl.appendChild(video)
    } else {
      // 图片壁纸
      wallpaperEl.style.backgroundImage = `url(${wallpaper.src})`
    }
  }

  // ==================== 返回 ====================

  return {
    // 状态
    currentWallpaper,
    isLoading,
    wallpaperList,
    currentCategory,

    // 方法
    loadWallpaperList,
    getRandomWallpaper,
    getUnsplashWallpaper,
    setWallpaper,
    setWallpaperType,
    setMask,
    setBlur,
    switchWallpaper,
    likeWallpaper,
    initWallpaper
  }
}

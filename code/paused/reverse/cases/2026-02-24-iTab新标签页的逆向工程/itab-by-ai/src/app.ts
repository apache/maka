/**
 * Vue 应用根组件
 *
 * 功能:
 * - 提供全局状态
 * - 渲染主界面
 */

import { defineComponent, onMounted, ref } from 'vue'
import { useUser } from './composables/useUser'
import { useConfig } from './composables/useConfig'
import { useWallpaper } from './composables/useWallpaper'
import { useWeather } from './composables/useWeather'

/**
 * App 根组件
 */
export default defineComponent({
  name: 'App',
  setup() {
    // ==================== 状态 ====================

    const isReady = ref(false)
    const error = ref<string | null>(null)

    // ==================== Hooks ====================

    const { isLoggedIn, initUser } = useUser()
    const { baseConfig, navConfig, initConfig } = useConfig()
    const { currentWallpaper, initWallpaper } = useWallpaper()
    const { currentWeather, initWeather } = useWeather()

    // ==================== 生命周期 ====================

    onMounted(async () => {
      try {
        // 初始化已完成（main.ts 中已调用 init* 函数）
        isReady.value = true
      } catch (err) {
        error.value = err instanceof Error ? err.message : '初始化失败'
        console.error('App 初始化失败:', err)
      }
    })

    // ==================== 渲染 ====================

    return () => (
      <div id="app" class="w-full h-full relative">
        {/* 壁纸背景 */}
        <div
          class="wallpaper"
          style={{
            backgroundImage: currentWallpaper.value.src
              ? `url(${currentWallpaper.value.src})`
              : 'none',
            backgroundColor: currentWallpaper.value.type === 3
              ? currentWallpaper.value.src
              : 'transparent',
            backdropFilter: `blur(${currentWallpaper.value.blur}px)`
          }}
        />

        {/* 主内容 */}
        {isReady.value ? (
          <div class="app-content">
            {/* TODO: 渲染子组件 */}
            <h1>iTab 新标签页</h1>
            <p>逆向工程还原项目</p>

            {/* 调试信息 */}
            {import.meta.env.DEV && (
              <div class="debug-info">
                <h3>调试信息</h3>
                <p>已登录: {isLoggedIn.value ? '是' : '否'}</p>
                <p>壁纸类型: {currentWallpaper.value.type}</p>
                <p>天气: {currentWeather.value?.now?.temp || '--'}°C</p>
              </div>
            )}
          </div>
        ) : (
          <div class="loading">加载中...</div>
        )}

        {/* 错误提示 */}
        {error.value && (
          <div class="error-message">{error.value}</div>
        )}
      </div>
    )
  }
})

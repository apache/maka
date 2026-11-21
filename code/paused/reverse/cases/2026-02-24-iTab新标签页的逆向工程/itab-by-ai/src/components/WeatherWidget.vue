<template>
  <div class="weather-widget">
    <!-- 加载中 -->
    <div v-if="isLoading" class="weather-loading">
      <span class="spinner"></span>
    </div>

    <!-- 天气信息 -->
    <div v-else-if="weather" class="weather-info">
      <!-- 温度和图标 -->
      <div class="weather-main">
        <img
          :src="weatherIconUrl"
          :alt="weather.now.text"
          class="weather-icon"
        />
        <span class="temperature">{{ weather.now.temp }}°</span>
      </div>

      <!-- 天气描述 -->
      <div class="weather-desc">{{ weatherText }}</div>

      <!-- 位置 -->
      <div v-if="showLocation" class="weather-location">
        {{ locationName }}
      </div>

      <!-- 日出日落 -->
      <div v-if="showSunTime && isDayTime !== null" class="weather-sun">
        <span v-if="isDayTime" class="sunrise">
          🌅 日出 {{ sunriseTime }}
        </span>
        <span v-else class="sunset">
          🌇 日落 {{ sunsetTime }}
        </span>
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else class="weather-error">
      <span class="error-icon">⚠️</span>
      <span class="error-text">天气加载失败</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Weather 天气组件
 *
 * 功能:
 * - 显示当前天气
 * - 显示温度和图标
 * - 显示位置信息
 * - 显示日出日落
 */

import { computed } from 'vue'
import { useWeather } from '../composables/useWeather'

// ==================== Props ====================

interface Props {
  showLocation?: boolean
  showSunTime?: boolean
  autoRefresh?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showLocation: true,
  showSunTime: false,
  autoRefresh: true
})

// ==================== Composables ====================

const {
  currentWeather: weather,
  isLoading,
  weatherIcon,
  weatherText,
  locationName,
  isDay,
  sunriseTime,
  sunsetTime
} = useWeather()

// ==================== 计算属性 ====================

/**
 * 天气图标 URL
 */
const weatherIconUrl = computed(() => {
  const iconCode = weather.value?.now?.icon || '100'
  return `https://files.codelife.cc/weather/${iconCode}.png`
})

/**
 * 是否为白天
 */
const isDayTime = computed(() => isDay.value)
</script>

<style scoped>
.weather-widget {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  color: white;
  font-size: 14px;
}

.weather-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.weather-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.weather-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.weather-icon {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.temperature {
  font-size: 24px;
  font-weight: 500;
}

.weather-desc {
  font-size: 12px;
  opacity: 0.8;
}

.weather-location {
  font-size: 12px;
  opacity: 0.7;
}

.weather-sun {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 2px;
}

.weather-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px;
}

.error-icon {
  font-size: 20px;
}

.error-text {
  font-size: 12px;
  opacity: 0.7;
}
</style>

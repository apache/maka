<template>
  <div
    ref="dateRef"
    class="date-widget"
    :style="widgetStyle"
    @click="handleClick"
  >
    <!-- 时间 -->
    <div class="time" :class="{ 'sec-hidden': !config.sec }">
      <span class="hh">{{ hour }}</span>
      <span class="colon">:</span>
      <span class="mm">{{ minute }}</span>
      <span v-if="config.sec" class="colon">:</span>
      <span v-if="config.sec" class="ss">{{ second }}</span>
    </div>

    <!-- 日期 -->
    <div class="date">
      <span class="month">{{ month }}</span>
      <span class="week">{{ weekday }}</span>
      <span v-if="config.showLunar" class="lunar">{{ lunar }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Date 时间组件
 *
 * 功能:
 * - 显示当前时间
 * - 显示日期和星期
 * - 显示农历
 * - 支持 12/24 小时制
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useConfig } from '../composables/useConfig'
import { formatDate, getWeekday, getLunarDate } from '../utils/date'
import type { TimeConfig } from '../types'

// ==================== Props ====================

interface Props {
  showLunar?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showLunar: true
})

// ==================== Composables ====================

const { baseConfig } = useConfig()

// ==================== 状态 ====================

const dateRef = ref<HTMLElement>()
const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null

// ==================== 计算属性 ====================

/**
 * 时间配置
 */
const config = computed((): TimeConfig => baseConfig.value.time)

/**
 * 组件样式
 */
const widgetStyle = computed(() => ({
  '--time-size': config.value.size,
  '--time-font': config.value.font,
  '--time-fontWeight': config.value.fontWeight,
  '--time-color': config.value.color || '#ffffff',
  '--time-sec': config.value.sec ? 'inline' : 'none'
}))

/**
 * 小时
 */
const hour = computed(() => {
  const format = config.value.hour24 ? 'HH' : 'hh'
  return formatDate(now.value, format)
})

/**
 * 分钟
 */
const minute = computed(() => {
  return formatDate(now.value, 'mm')
})

/**
 * 秒
 */
const second = computed(() => {
  return formatDate(now.value, 'ss')
})

/**
 * 月份日期
 */
const month = computed(() => {
  return formatDate(now.value, 'M月D日')
})

/**
 * 星期
 */
const weekday = computed(() => {
  return '星期' + getWeekday(now.value)
})

/**
 * 农历
 */
const lunar = computed(() => {
  if (!props.showLunar) return ''
  const lunarDate = getLunarDate(now.value)
  return `${lunarDate.month}${lunarDate.day}`
})

// ==================== 方法 ====================

/**
 * 更新时间
 */
function updateTime() {
  now.value = new Date()
}

/**
 * 处理点击
 */
function handleClick() {
  // TODO: 实现点击切换布局视图
  console.log('Date widget clicked')
}

// ==================== 生命周期 ====================

onMounted(() => {
  // 每秒更新
  timer = setInterval(updateTime, 1000)
})

onUnmounted(() => {
  if (timer) {
    clearInterval(timer)
  }
})
</script>

<style scoped>
.date-widget {
  user-select: none;
  text-align: center;
  color: var(--time-color, #ffffff);
  cursor: pointer;
}

.time {
  font-size: var(--time-size, 80px);
  font-family: var(--time-font, inherit);
  font-weight: var(--time-fontWeight, 400);
  line-height: var(--time-size);
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.16);
  transition: font 0.2s ease;
}

.colon {
  vertical-align: calc(var(--time-size) / 12);
}

.sec {
  display: var(--time-sec, inline);
}

.date {
  font-size: 14px;
  line-height: 26px;
  opacity: 0.88;
  margin-top: -3px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.16);
}

.date span {
  margin: 0 2px;
}

.lunar {
  display: block;
}
</style>

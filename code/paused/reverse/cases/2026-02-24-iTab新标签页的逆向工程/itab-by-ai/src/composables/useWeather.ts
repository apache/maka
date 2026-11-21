/**
 * useWeather - 天气数据组合式函数
 *
 * 功能:
 * - 获取天气数据 (使用和风天气 API)
 * - 自动定位
 * - 缓存管理
 * - 日夜判断
 */

import { ref, computed } from 'vue'
import dayjs from 'dayjs'
import type { WeatherData, WeatherLocation } from '../types'
import indexdb from '../storage/indexdb'

// ==================== 常量 ====================

/**
 * 存储键
 */
const STORAGE_KEYS = {
  WEATHER: 'weather',
  DEFAULT_CITY: 'weather-default-city'
}

/**
 * 缓存时间
 */
const CACHE_TTL = {
  WEATHER: 10 * 60 * 1000,        // 10 分钟
  DEFAULT_CITY: 30 * 60 * 1000    // 30 分钟
}

// ==================== 状态 ====================

/**
 * 当前天气数据
 */
const currentWeather = ref<WeatherData | null>(null)

/**
 * 加载状态
 */
const isLoading = ref(false)

/**
 * 错误信息
 */
const error = ref<string | null>(null)

// ==================== 核心功能 ====================

/**
 * 天气管理 Hook
 */
export function useWeather() {
  // ==================== 天气获取 ====================

  /**
   * 获取天气数据
   * @param location 位置 ID 或经纬度字符串
   * @param forceRefresh 是否强制刷新
   */
  async function getWeather(location?: string, forceRefresh = false): Promise<WeatherData | null> {
    try {
      isLoading.value = true
      error.value = null

      // 尝试从缓存获取
      if (!forceRefresh) {
        const cached = await indexdb.get<WeatherData>(STORAGE_KEYS.WEATHER)
        if (cached && cached.location) {
          currentWeather.value = cached
          return cached
        }
      }

      // 如果没有指定位置，获取默认位置
      let locationId = location
      if (!locationId) {
        const defaultCity = await indexdb.get<WeatherData>(STORAGE_KEYS.DEFAULT_CITY)
        if (defaultCity?.location?.id) {
          locationId = defaultCity.location.id
        }
      }

      // 如果还是没有位置，尝试自动定位
      if (!locationId) {
        const autoLocation = await getAutoLocation()
        if (autoLocation) {
          locationId = autoLocation
        }
      }

      if (!locationId) {
        throw new Error('无法获取位置信息')
      }

      // 调用天气 API
      const weatherData = await fetchWeatherData(locationId)

      if (!weatherData) {
        throw new Error('获取天气数据失败')
      }

      // 判断日夜
      weatherData.moment = getDayNightMoment(weatherData.sun?.rise, weatherData.sun?.set)
      weatherData.updateTime = dayjs().valueOf()

      // 保存到缓存
      await indexdb.set(STORAGE_KEYS.WEATHER, weatherData, CACHE_TTL.WEATHER)

      currentWeather.value = weatherData
      return weatherData

    } catch (err) {
      const message = err instanceof Error ? err.message : '获取天气失败'
      error.value = message
      console.error('获取天气失败:', err)
      return null
    } finally {
      isLoading.value = false
    }
  }

  /**
   * 获取天气数据 (通过 API)
   */
  async function fetchWeatherData(location: string): Promise<WeatherData | null> {
    try {
      // 这里需要通过代理访问和风天气 API
      // 实际项目中需要配置代理服务
      const response = await fetch(`https://api.codelife.cc/weather?q=${location}&lang=cn`)
      const data = await response.json()

      if (data.code !== '200') {
        return null
      }

      return transformWeatherData(data)
    } catch (err) {
      console.error('获取天气 API 失败:', err)
      return null
    }
  }

  /**
   * 转换天气数据格式
   */
  function transformWeatherData(data: any): WeatherData {
    return {
      now: {
        temp: data.now?.temp || '--',
        text: data.now?.text || '未知',
        icon: data.now?.icon || '100',
        humidity: data.now?.humidity || '--',
        windDir: data.now?.windDir || '--',
        windScale: data.now?.windScale || '--'
      },
      location: {
        id: data.location?.[0]?.id || '',
        name: data.location?.[0]?.name || '未知',
        adm1: data.location?.[0]?.adm1 || '',
        adm2: data.location?.[0]?.adm2 || '',
        country: data.location?.[0]?.country || '中国',
        location: data.location?.[0]?.location || '',
        isAuto: true
      },
      daily_forecast: data.daily?.map((d: any) => ({
        fxDate: d.fxDate,
        tempMax: d.tempMax,
        tempMin: d.tempMin,
        textDay: d.textDay,
        textNight: d.textNight,
        iconDay: d.iconDay,
        iconNight: d.iconNight
      })) || [],
      sun: {
        rise: data.sun?.rise || '',
        set: data.sun?.set || ''
      }
    }
  }

  // ==================== 定位 ====================

  /**
   * 自动获取位置
   */
  async function getAutoLocation(): Promise<string | null> {
    try {
      const position = await getCurrentPosition()
      if (position && position.coords) {
        const { latitude, longitude } = position.coords
        const locationId = `${longitude},${latitude}`

        // 通过地理编码获取城市信息
        const cityInfo = await getLocationInfo(locationId)
        if (cityInfo) {
          // 保存为默认城市
          const defaultCity: WeatherData = {
            now: { temp: '', text: '', icon: '', humidity: '', windDir: '', windScale: '' },
            location: cityInfo,
            updateTime: Date.now()
          }
          await indexdb.set(STORAGE_KEYS.DEFAULT_CITY, defaultCity, CACHE_TTL.DEFAULT_CITY)
        }

        return locationId
      }
    } catch (err) {
      console.error('自动定位失败:', err)
    }
    return null
  }

  /**
   * 获取当前位置
   */
  function getCurrentPosition(): Promise<GeolocationPosition | null> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null)
        return
      }

      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position),
        () => resolve(null),
        { timeout: 5000 }
      )
    })
  }

  /**
   * 获取位置信息
   */
  async function getLocationInfo(coords: string): Promise<WeatherLocation | null> {
    try {
      const response = await fetch(`https://api.codelife.cc/location?coords=${coords}&lang=cn`)
      const data = await response.json()

      if (data.status === 1 && data.data) {
        return {
          id: data.data.id,
          name: data.data.name,
          adm1: data.data.adm1,
          adm2: data.data.adm2,
          country: data.data.country,
          location: data.data.location,
          ip: data.data.ip,
          isAuto: true
        }
      }
    } catch (err) {
      console.error('获取位置信息失败:', err)
    }
    return null
  }

  // ==================== 工具函数 ====================

  /**
   * 判断日夜
   */
  function getDayNightMoment(sunrise?: string, sunset?: string): 'd' | 'n' {
    if (!sunrise || !sunset) {
      // 根据当前时间判断
      const hour = dayjs().hour()
      return hour >= 6 && hour < 18 ? 'd' : 'n'
    }

    const now = dayjs()
    const today = now.format('YYYY-MM-DD')

    const riseTime = dayjs(`${today} ${sunrise}`).valueOf()
    const setTime = dayjs(`${today} ${sunset}`).valueOf()
    const current = now.valueOf()

    return current > riseTime && current < setTime ? 'd' : 'n'
  }

  /**
   * 获取天气图标 URL
   */
  function getWeatherIcon(iconCode: string): string {
    return `https://files.codelife.cc/weather/${iconCode}.png`
  }

  /**
   * 刷新天气
   */
  async function refresh() {
    await getWeather(undefined, true)
  }

  // ==================== 计算属性 ====================

  /**
   * 当前温度
   */
  const temperature = computed(() => currentWeather.value?.now?.temp || '--')

  /**
   * 天气描述
   */
  const weatherText = computed(() => currentWeather.value?.now?.text || '--')

  /**
   * 天气图标
   */
  const weatherIcon = computed(() => {
    const iconCode = currentWeather.value?.now?.icon || '100'
    return getWeatherIcon(iconCode)
  })

  /**
   * 位置名称
   */
  const locationName = computed(() => currentWeather.value?.location?.name || '--')

  /**
   * 是否白天
   */
  const isDay = computed(() => currentWeather.value?.moment === 'd')

  /**
   * 日出时间
   */
  const sunriseTime = computed(() => currentWeather.value?.sun?.rise || '--')

  /**
   * 日落时间
   */
  const sunsetTime = computed(() => currentWeather.value?.sun?.set || '--')

  // ==================== 初始化 ====================

  /**
   * 初始化天气
   */
  async function initWeather() {
    // 先从缓存加载
    const cached = await indexdb.get<WeatherData>(STORAGE_KEYS.WEATHER)
    if (cached) {
      currentWeather.value = cached
    }

    // 然后刷新数据
    await getWeather()
  }

  // ==================== 返回 ====================

  return {
    // 状态
    currentWeather,
    isLoading,
    error,

    // 计算属性
    temperature,
    weatherText,
    weatherIcon,
    locationName,
    isDay,
    sunriseTime,
    sunsetTime,

    // 方法
    getWeather,
    refresh,
    initWeather,
    getWeatherIcon
  }
}

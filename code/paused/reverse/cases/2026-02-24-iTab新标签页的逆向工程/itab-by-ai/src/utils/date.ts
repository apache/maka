/**
 * 日期时间工具
 * 基于 dayjs 封装
 *
 * 功能:
 * - 日期格式化
 * - 相对时间
 * - 农历转换
 */

import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import calendar from 'dayjs/plugin/calendar'
import duration from 'dayjs/plugin/duration'

// 扩展 dayjs 插件
dayjs.extend(relativeTime)
dayjs.extend(calendar)
dayjs.extend(duration)

/**
 * 星期映射
 */
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 生肖映射
 */
export const ZODIAC_ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']

/**
 * 天干映射
 */
export const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']

/**
 * 地支映射
 */
export const EARTHLY_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']

// ==================== 日期格式化 ====================

/**
 * 格式化日期
 */
export function formatDate(date: Date | string | number, format = 'YYYY-MM-DD'): string {
  return dayjs(date).format(format)
}

/**
 * 格式化时间
 */
export function formatTime(date: Date | string | number, format = 'HH:mm:ss'): string {
  return dayjs(date).format(format)
}

/**
 * 格式化日期时间
 */
export function formatDateTime(date: Date | string | number, format = 'YYYY-MM-DD HH:mm:ss'): string {
  return dayjs(date).format(format)
}

/**
 * 获取星期
 */
export function getWeekday(date: Date | string | number = Date.now()): string {
  return WEEKDAYS[dayjs(date).day()]
}

/**
 * 获取星期 (英文)
 */
export function getWeekdayEn(date: Date | string | number = Date.now()): string {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return weekdays[dayjs(date).day()]
}

// ==================== 相对时间 ====================

/**
 * 相对时间 (如 "3小时前")
 */
export function fromNow(date: Date | string | number): string {
  return dayjs(date).fromNow()
}

/**
 * 相对时间 (到指定时间)
 */
export function toNow(date: Date | string | number): string {
  return dayjs(date).toNow()
}

/**
 * 日历格式
 */
export function calendar(date: Date | string | number): string {
  return dayjs(date).calendar()
}

// ==================== 日期计算 ====================

/**
 * 添加天数
 */
export function addDays(date: Date | string | number, days: number): Date {
  return dayjs(date).add(days, 'day').toDate()
}

/**
 * 添加月数
 */
export function addMonths(date: Date | string | number, months: number): Date {
  return dayjs(date).add(months, 'month').toDate()
}

/**
 * 添加年数
 */
export function addYears(date: Date | string | number, years: number): Date {
  return dayjs(date).add(years, 'year').toDate()
}

/**
 * 日期差 (天数)
 */
export function diffDays(date1: Date | string | number, date2: Date | string | number = Date.now()): number {
  return dayjs(date1).diff(dayjs(date2), 'day')
}

/**
 * 日期差 (小时)
 */
export function diffHours(date1: Date | string | number, date2: Date | string | number = Date.now()): number {
  return dayjs(date1).diff(dayjs(date2), 'hour')
}

// ==================== 农历 ====================

/**
 * 农历日期信息
 */
export interface LunarDate {
  year: string      // 天干地支年
  month: string     // 农历月
  day: string       // 农历日
  zodiac: string    // 生肖
  isLeap: boolean   // 是否闰月
}

/**
 * 简化的农历转换
 *
 * 注意: 完整的农历算法非常复杂，这里提供简化版本
 * 实际项目建议使用专门的农历库
 */
export function getLunarDate(date: Date | string | number = Date.now()): LunarDate {
  const d = dayjs(date)
  const year = d.year()
  const month = d.month() + 1
  const day = d.date()

  // 简化计算 (仅作演示)
  const zodiacIndex = (year - 4) % 12
  const stemIndex = (year - 4) % 10
  const branchIndex = (year - 4) % 12

  return {
    year: `${HEAVENLY_STEMS[stemIndex]}${EARTHLY_BRANCHES[branchIndex]}年`,
    month: `${month}月`,
    day: `${day}日`,
    zodiac: ZODIAC_ANIMALS[zodiacIndex],
    isLeap: false
  }
}

// ==================== 工具函数 ====================

/**
 * 获取时间戳
 */
export function getTimestamp(date: Date | string | number = Date.now()): number {
  return dayjs(date).valueOf()
}

/**
 * 判断是否为今天
 */
export function isToday(date: Date | string | number): boolean {
  return dayjs(date).isSame(dayjs(), 'day')
}

/**
 * 判断是否为本周
 */
export function isThisWeek(date: Date | string | number): boolean {
  return dayjs(date).isSame(dayjs(), 'week')
}

/**
 * 获取月份天数
 */
export function getDaysInMonth(date: Date | string | number): number {
  return dayjs(date).daysInMonth()
}

/**
 * 获取月份第一天
 */
export function getFirstDayOfMonth(date: Date | string | number): Date {
  return dayjs(date).startOf('month').toDate()
}

/**
 * 获取月份最后一天
 */
export function getLastDayOfMonth(date: Date | string | number): Date {
  return dayjs(date).endOf('month').toDate()
}

/**
 * 时间戳转日期
 */
export function timestampToDate(timestamp: number): Date {
  return dayjs(timestamp).toDate()
}

/**
 * 倒计时
 */
export interface Countdown {
  days: number
  hours: number
  minutes: number
  seconds: number
}

export function getCountdown(targetDate: Date | string | number): Countdown {
  const now = dayjs()
  const target = dayjs(targetDate)
  const diff = target.diff(now)

  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0 }
  }

  const d = dayjs.duration(diff)

  return {
    days: Math.floor(d.asDays()),
    hours: d.hours(),
    minutes: d.minutes(),
    seconds: d.seconds()
  }
}

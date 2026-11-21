import type { VenueCategory } from '@/features/date-playbook/domain/types'

export const CATEGORY_LABELS: Record<VenueCategory, string> = {
  snack: '小吃',
  drink: '饮品',
  restaurant: '中餐',
  hotpot: '火锅',
  barbecue: '烧烤',
  food_stall: '大排档',
  park: '公园',
  museum: '博物馆',
  cinema: '电影院',
  indoor_fun: '室内玩乐',
  shopping: '商圈'
}

/** 融合料理等细分通过 subCategory 表达，主分类保持与数据模型一致 */
export const CATEGORY_LIST = Object.keys(CATEGORY_LABELS) as VenueCategory[]

export const SCENE_OPTIONS = [
  '安静聊天',
  '拍照打卡',
  '雨天适合',
  '散步',
  '夜宵',
  '正餐'
] as const

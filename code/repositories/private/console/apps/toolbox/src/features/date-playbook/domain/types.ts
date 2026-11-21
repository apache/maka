/**
 * 业务领域类型集中定义
 * 来源：阳西约会攻略-产品与开发方案.md 第 7 节 / K3 开发提示词 第十节
 * 页面与 store 只允许依赖这里的类型，不允许在各页面重复定义
 */

export interface User {
  id: string
  openId: string
  nickname: string
  avatarUrl?: string
  createdAt: string
  updatedAt: string
}

export type RelationshipStage =
  | 'initial_contact'
  | 'stable_chat'
  | 'prepare_meeting'
  | 'first_date'
  | 'continued_dates'
  | 'deep_understanding'
  | 'serious_development'
  | 'relationship_confirmed'
  | 'stable_relationship'

export interface CoupleSpace {
  id: string
  name: string
  inviteCode: string
  memberIds: string[]
  currentStage: RelationshipStage
  relationshipStartDate?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type VenueCategory =
  | 'snack'
  | 'drink'
  | 'restaurant'
  | 'hotpot'
  | 'barbecue'
  | 'food_stall'
  | 'park'
  | 'museum'
  | 'cinema'
  | 'indoor_fun'
  | 'shopping'

export type VerifyStatus = 'unverified' | 'verified' | 'outdated'

export type TimeTag = 'morning' | 'noon' | 'afternoon' | 'evening' | 'late_night'

export type WeatherTag = 'sunny' | 'rainy' | 'hot' | 'cool'

export interface Venue {
  id: string
  name: string
  category: VenueCategory
  subCategory?: string
  address: string
  area: string
  openTime?: string
  avgPriceMin?: number
  avgPriceMax?: number
  ticketPriceText?: string
  signatureItems: string[]
  highlights: string[]
  suitableScenes: string[]
  reviewSummary?: string
  isPopular?: boolean
  openYears?: number
  bookingLevel: 'none' | 'recommended' | 'required'
  bookingNote?: string
  isIndoor: boolean
  isFree: boolean
  timeTags: TimeTag[]
  weatherTags: WeatherTag[]
  longitude?: number
  latitude?: number
  verifyStatus: VerifyStatus
  verifiedAt?: string
  sourceNote: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type FavoriteStatus = 'want_to_go' | 'visited'

export interface Favorite {
  id: string
  coupleId: string
  venueId: string
  userId: string
  status: FavoriteStatus
  createdAt: string
  updatedAt: string
}

export type DatePlanStatus =
  | 'draft'
  | 'pending_confirmation'
  | 'confirmed'
  | 'completed'
  | 'cancelled'

export interface DatePlan {
  id: string
  coupleId: string
  title: string
  date: string
  startTime?: string
  endTime?: string
  venueIds: string[]
  meetingNote?: string
  estimatedBudget?: number
  topics: string[]
  cautions: string[]
  backupPlan?: string
  bookingRequired: boolean
  status: DatePlanStatus
  createdBy: string
  confirmedBy?: string
  confirmedAt?: string
  createdAt: string
  updatedAt: string
}

export interface DateReview {
  id: string
  planId: string
  coupleId: string
  userId: string
  feeling: 1 | 2 | 3 | 4 | 5
  favoritePart: string
  regretPart?: string
  willingAgain: boolean
  messageToPartner?: string
  createdAt: string
  updatedAt: string
}

export type TimelineEventType =
  | 'couple_created'
  | 'partner_joined'
  | 'stage_changed'
  | 'plan_confirmed'
  | 'date_completed'
  | 'manual_memory'

export interface TimelineEvent {
  id: string
  coupleId: string
  type: TimelineEventType
  title: string
  content?: string
  relatedId?: string
  createdBy: string
  createdAt: string
}

export type StageProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface StageProposal {
  id: string
  coupleId: string
  fromStage: RelationshipStage
  toStage: RelationshipStage
  reason: string
  proposerId: string
  status: StageProposalStatus
  responderId?: string
  respondedAt?: string
  createdAt: string
}

export type MemoryLevel = 'high' | 'medium' | 'low'

export type RepeatRisk = 'high' | 'medium' | 'low'

/** 从聊天导出剥离后的生活事实摘要，不含原话 */
export interface PartnerFactItem {
  id: string
  category: 'life' | 'relationship'
  subcategory: string
  summary: string
  date?: string
  memoryLevel: MemoryLevel
  repeatRisk: RepeatRisk
  relationshipRelevance: MemoryLevel
}

/** 已问话题账本，只保留主题与是否回答，不含完整问句 */
export interface AskedTopic {
  id: string
  topic: string
  date?: string
  answered: boolean
  depth?: string
  repeatRisk?: RepeatRisk
}

export interface DoNotRepeatItem {
  summary: string
  repeatRisk: RepeatRisk
  date?: string
}

export interface VisitMemory {
  date: string
  title: string
  content: string
}

export type FamilyLineage = 'paternal' | 'maternal'

export type FamilyChildGender = 'boy' | 'girl'

export interface FamilyGrandchild {
  label: string
}

export interface FamilyChild {
  order: number
  gender: FamilyChildGender
  name: string
  spouse?: string
  isSelf?: boolean
  grandchildren: FamilyGrandchild[]
}

export interface FamilyHousehold {
  id: string
  lineage: FamilyLineage
  title: string
  deceased: boolean
  relationNote?: string
  children: FamilyChild[]
}

/** 亲人图谱。数据来自家庭关系 HTML，不含聊天原文 */
export interface FamilyTree {
  enabled: boolean
  title: string
  motto: string
  year?: string
  paternal: FamilyHousehold[]
  maternal: FamilyHousehold[]
}

/** 对方生活档案。enabled 为 false 时页面展示空态，时间线不合成见面记忆 */
export interface PartnerArchive {
  enabled: boolean
  source: 'demo' | 'chat-memory'
  generatedAt?: string
  partnerName: string
  headline?: string
  summary?: string
  facts: {
    location: string[]
    job: string[]
    habits: string[]
  }
  items: PartnerFactItem[]
  askedTopics: AskedTopic[]
  doNotRepeat: DoNotRepeatItem[]
  visits: VisitMemory[]
  familyTree: FamilyTree
}

/** 云函数统一返回结构 */
export interface ApiResult<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

import type { RelationshipStage } from '@/features/date-playbook/domain/types'

/** 阶段顺序即关系推进顺序，允许前进和回退 */
export const STAGE_ORDER: RelationshipStage[] = [
  'initial_contact',
  'stable_chat',
  'prepare_meeting',
  'first_date',
  'continued_dates',
  'deep_understanding',
  'serious_development',
  'relationship_confirmed',
  'stable_relationship'
]

export const STAGE_LABELS: Record<RelationshipStage, string> = {
  initial_contact: '初步认识',
  stable_chat: '稳定聊天',
  prepare_meeting: '准备见面',
  first_date: '第一次约会',
  continued_dates: '持续约会',
  deep_understanding: '深入了解',
  serious_development: '双方确认认真发展',
  relationship_confirmed: '确认关系',
  stable_relationship: '稳定发展'
}

/** 阶段页面的固定提示语，不得删除 */
export const STAGE_DISCLAIMER = '阶段只是共同记录，需要以真实沟通为准'

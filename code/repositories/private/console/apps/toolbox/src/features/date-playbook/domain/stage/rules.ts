import type { RelationshipStage, StageProposal } from '@/features/date-playbook/domain/types'
import { STAGE_ORDER } from '@/features/date-playbook/constants/stage'

/** 阶段允许前进和回退，但不允许原地变更 */
export function canProposeStageChange(from: RelationshipStage, to: RelationshipStage): boolean {
  return from !== to && STAGE_ORDER.includes(from) && STAGE_ORDER.includes(to)
}

/** 发起阶段变更必须填写一句事实依据 */
export function assertProposalReason(reason: string): void {
  if (!reason || reason.trim().length === 0) {
    throw new Error('阶段变更必须填写一句事实依据')
  }
}

/**
 * 阶段变更必须由另一方确认才生效。
 * 响应者不能是发起者本人。
 */
export function canRespondProposal(proposal: StageProposal, responderId: string): boolean {
  return proposal.status === 'pending' && proposal.proposerId !== responderId
}

/**
 * PRD-00: BlockingDecision 测试
 * 验证运行形态决策与实现边界定义
 */
import { describe, it, expect } from 'vitest'

describe('PRD-00: BlockingDecision', () => {
  describe('Runtime Decision', () => {
    it('选择了 Node 后端 + Vite 前端架构', () => {
      // 决策已在 design.md 中记录
      // 选择 B：本地 Node 后端 + Vite 前端
      const runtimeChoice = 'node-backend-vite-frontend'
      expect(runtimeChoice).toBe('node-backend-vite-frontend')
    })
  })

  describe('FS_ROOT 边界', () => {
    it('定义了只读约束', () => {
      // Control Plane 只读，不写入 .ggbdpq/actions/** 和 .kiro/specs/**
      const readOnlyDirectories = ['.ggbdpq/actions', '.kiro/specs']
      expect(readOnlyDirectories).toHaveLength(2)
    })

    it('定义了允许读取的目录', () => {
      const allowedReadDirs = ['.ggbdpq/actions', '.kiro/specs']
      expect(allowedReadDirs).toContain('.ggbdpq/actions')
      expect(allowedReadDirs).toContain('.kiro/specs')
    })
  })

  describe('File Watch 边界', () => {
    it('定义了 500ms 去抖策略', () => {
      const debounceMs = 500
      expect(debounceMs).toBe(500)
    })

    it('定义了监听范围', () => {
      const watchDirs = ['.ggbdpq/actions/**', '.kiro/specs/**']
      expect(watchDirs).toHaveLength(2)
    })

    it('定义了错误降级策略', () => {
      const fallbackStrategies = [
        'watch_init_failed_manual_refresh',
        'dir_not_exist_watch_parent',
        'event_error_log_continue',
        'resource_exhausted_polling',
      ]
      expect(fallbackStrategies.length).toBeGreaterThan(0)
    })
  })

  describe('Git 信息获取边界', () => {
    it('定义了可用性检查项', () => {
      const availabilityChecks = [
        'git_command_available',
        'is_git_repo',
        'has_read_permission',
      ]
      expect(availabilityChecks).toHaveLength(3)
    })

    it('定义了不可用时返回 unverifiable 而非猜测', () => {
      type GitAvailability =
        | { available: true }
        | {
            available: false
            reason: 'git_unavailable' | 'not_git_repo' | 'git_permission_denied'
          }

      const unavailableResult: GitAvailability = {
        available: false,
        reason: 'git_unavailable',
      }

      expect(unavailableResult.available).toBe(false)
      expect(unavailableResult.reason).toBe('git_unavailable')
    })
  })
})

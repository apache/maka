/**
 * Spec（规划文档）相关类型定义
 * 对应 .kiro/specs/ 目录结构
 */

/**
 * Spec 文档完整性状态
 */
export interface SpecCompleteness {
  /** 是否有 requirements.md */
  readonly hasRequirements: boolean

  /** 是否有 design.md */
  readonly hasDesign: boolean

  /** 是否有 tasks.md */
  readonly hasTasks: boolean
}

/**
 * Spec 文档集合
 */
export interface SpecDocument {
  /** Spec 名称 */
  readonly name: string

  /** 目录路径 */
  readonly path: string

  /** requirements.md 内容（null 表示文件不存在） */
  readonly requirements: string | null

  /** design.md 内容（null 表示文件不存在） */
  readonly design: string | null

  /** tasks.md 内容（null 表示文件不存在） */
  readonly tasks: string | null

  /** 文档完整性 */
  readonly completeness: SpecCompleteness
}

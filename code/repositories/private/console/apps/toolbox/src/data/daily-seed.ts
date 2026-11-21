import type { DailyReport, SourceConfig, SourceHealth } from "@/schemas/daily"

/**
 * 日报域种子数据。
 *
 * ⚠️ 原文件因根 .gitignore 的 `data/` 规则误伤 src/data/ 从未入库，本机副本已丢失。
 * 当前为按调用点反推的空种子：日报列表/信源面板将显示为空态，页面逻辑不受影响。
 * 历史日报 fixture 与默认信源配置需人工补录。
 */

export const seededReports: DailyReport[] = []

export const defaultSourceConfigs: SourceConfig[] = []

export const demoSourceHealth: SourceHealth[] = []

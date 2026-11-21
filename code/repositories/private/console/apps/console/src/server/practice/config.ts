/** 实践台同步配置：仓库清单、作者身份、默认时间窗口。加仓库/换作者改这里即可。 */

export interface PracticeRepoConfig {
  name: string
  path: string
}

export const PRACTICE_REPOS: PracticeRepoConfig[] = [
  { name: 'beauty-smart-advisor', path: 'E:/2026-09-08/frontend/beauty-smart-advisor' },
  { name: 'homing-miniapp-workbench', path: 'E:/2026-09-08/frontend/homing-miniapp-workbench' },
  { name: 'homing-miniapp-brand', path: 'E:/2026-09-08/frontend/homing-miniapp-brand' },
  { name: 'homing-sub-pedestal', path: 'E:/2026-09-08/frontend/homing-sub-pedestal' },
]

/** 作者用邮箱匹配（git --author 为正则，多身份用 | 连接） */
export const PRACTICE_AUTHORS = ['802165@clife\\.cn']

/** 默认窗口（含首尾两天）；git 查询时 until 会 +1 天补足当天 */
export const DEFAULT_WINDOW = {
  since: '2026-04-16',
  until: '2026-09-13',
}

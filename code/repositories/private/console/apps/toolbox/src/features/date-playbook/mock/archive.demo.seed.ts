import type { PartnerArchive } from '@/features/date-playbook/domain/types'
import { createEmptyArchive } from '@/features/date-playbook/domain/archive/rules'
import { parseVisitFolderNames } from '@/features/date-playbook/domain/archive/visitFolders'

/**
 * Web 演示档案种子。内容全部为自拟中性演示数据（含聊天记忆目录名演示），
 * 不包含任何私人种子内容（archive.private 相关数据一律不迁移）。
 * 与小程序 demo seed 的差异：enabled 默认为 true，方便 Web 页面浏览；
 * 所有摘要均带「演示数据」前缀，页面同时展示 source === 'demo' 徽标。
 */

/** chat-memory/timeline 目录名演示素材（含一个应被跳过的目录） */
export const DEMO_VISIT_FOLDERS = [
  '20260218-年初二-在家吃饭&&晚上去大姑家拜年',
  '20260307-周六-老街拍照打卡&&晚饭逛小吃街',
  '20260321-周末-海边散步&&尝海鲜大排档',
  '交通与距离',
  '朋友圈照片',
] as const

export const DEMO_ARCHIVE_SEED: PartnerArchive = {
  ...createEmptyArchive('对方（演示）', 'demo'),
  enabled: true,
  generatedAt: '2026-08-30T00:00:00+08:00',
  headline: '本地演示档案',
  summary: '真实生活档案需在本机运行导入脚本生成，本页内容全部为演示数据，不含聊天原文。',
  facts: {
    location: ['阳西县城'],
    job: ['演示数据：工作日作息稳定（具体行业略）'],
    habits: ['演示数据：周末喜欢逛吃和拍照'],
  },
  familyTree: {
    enabled: true,
    title: '亲人图谱（演示数据）',
    motto: '家和万事兴 · 亲情永相连',
    year: '2026',
    paternal: [
      {
        id: 'paternal-1',
        lineage: 'paternal',
        title: '爷爷奶奶',
        deceased: false,
        relationNote: '演示数据：父亲的父母',
        children: [
          { order: 1, gender: 'boy', name: '大伯', grandchildren: [{ label: '堂哥' }, { label: '堂姐' }] },
          { order: 2, gender: 'girl', name: '姑姑', spouse: '姑父', grandchildren: [{ label: '表弟' }] },
        ],
      },
      {
        id: 'paternal-2',
        lineage: 'paternal',
        title: '爸爸妈妈',
        deceased: false,
        relationNote: '演示数据：她父母的小家',
        children: [
          { order: 1, gender: 'girl', name: '她本人', isSelf: true, grandchildren: [] },
          { order: 2, gender: 'boy', name: '弟弟', grandchildren: [] },
        ],
      },
    ],
    maternal: [
      {
        id: 'maternal-1',
        lineage: 'maternal',
        title: '外公外婆',
        deceased: false,
        relationNote: '演示数据：母亲的父母',
        children: [
          { order: 1, gender: 'girl', name: '大姨', spouse: '姨父', grandchildren: [{ label: '表姐' }] },
          { order: 2, gender: 'boy', name: '小舅', grandchildren: [] },
        ],
      },
    ],
  },
  items: [
    {
      id: 'demo-life-1',
      category: 'life',
      subcategory: '生活区域',
      summary: '演示数据：活动范围以阳西县城为主。',
      memoryLevel: 'medium',
      repeatRisk: 'low',
      relationshipRelevance: 'medium',
    },
    {
      id: 'demo-rel-1',
      category: 'relationship',
      subcategory: '相处偏好',
      summary: '演示数据：一起逛吃、把计划写清楚，比反复确认更舒服。',
      memoryLevel: 'medium',
      repeatRisk: 'low',
      relationshipRelevance: 'medium',
    },
    {
      id: 'demo-life-2',
      category: 'life',
      subcategory: '工作情况',
      summary: '演示数据：工作日作息稳定，周末偶尔要加班。',
      memoryLevel: 'medium',
      repeatRisk: 'medium',
      relationshipRelevance: 'low',
    },
    {
      id: 'demo-life-3',
      category: 'life',
      subcategory: '兴趣与休闲',
      summary: '演示数据：喜欢逛小吃街和拍照打卡。',
      memoryLevel: 'high',
      repeatRisk: 'low',
      relationshipRelevance: 'high',
    },
    {
      id: 'demo-life-4',
      category: 'life',
      subcategory: '饮食',
      summary: '演示数据：能吃辣，喜欢尝试新开的小店。',
      memoryLevel: 'medium',
      repeatRisk: 'low',
      relationshipRelevance: 'medium',
    },
    {
      id: 'demo-life-5',
      category: 'life',
      subcategory: '作息',
      summary: '演示数据：习惯早睡，晚上的安排不宜拖太晚。',
      memoryLevel: 'high',
      repeatRisk: 'medium',
      relationshipRelevance: 'high',
    },
    {
      id: 'demo-rel-2',
      category: 'relationship',
      subcategory: '价值观与判断',
      summary: '演示数据：觉得家人应该常走动，节日要一起吃饭。',
      memoryLevel: 'medium',
      repeatRisk: 'medium',
      relationshipRelevance: 'high',
    },
    {
      id: 'demo-rel-3',
      category: 'relationship',
      subcategory: '边界与雷区',
      summary: '演示数据：不喜欢被反复确认已经定好的安排。',
      memoryLevel: 'high',
      repeatRisk: 'medium',
      relationshipRelevance: 'high',
    },
  ],
  askedTopics: [
    { id: 'demo-ask-1', topic: '演示数据：她的工作节奏', date: '2026-02-12', answered: true, depth: '浅', repeatRisk: 'medium' },
    { id: 'demo-ask-2', topic: '演示数据：学生时代的经历', date: '2026-02-13', answered: true },
    { id: 'demo-ask-3', topic: '演示数据：喜欢的拍照风格', date: '2026-03-07', answered: true },
    { id: 'demo-ask-4', topic: '演示数据：周末通常怎么安排', answered: false },
    { id: 'demo-ask-5', topic: '演示数据：明年想去旅行的地方', answered: false },
    { id: 'demo-ask-6', topic: '演示数据：家里养不养宠物', answered: false },
  ],
  doNotRepeat: [
    { summary: '演示数据：已经问过做什么工作，别再翻来覆去问工作', repeatRisk: 'high', date: '2026-02-12' },
    { summary: '演示数据：她不喜欢被反复确认行程', repeatRisk: 'medium', date: '2026-02-20' },
    { summary: '演示数据：住哪一片已经聊过，别再重复问住哪', repeatRisk: 'low', date: '2026-02-13' },
  ],
  visits: parseVisitFolderNames([...DEMO_VISIT_FOLDERS]),
}

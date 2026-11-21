/**
 * useConfig - 配置管理组合式函数
 *
 * 功能:
 * - 基础配置管理
 * - 导航配置管理
 * - 配置持久化
 * - 配置重置
 */

import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { BaseConfig, NavConfig, AppConfig, IconItem, NavGroup, SearchEngine } from '../types'
import indexdb from '../storage/indexdb'
import chromeStorage from '../storage/chromeStorage'
import { useUser } from './useUser'

// ==================== 默认配置 ====================

/**
 * 默认时间配置
 */
const defaultTimeConfig: BaseConfig['time'] = {
  show: true,
  hour24: false,
  sec: true,
  size: '80px',
  font: 'inherit',
  fontWeight: '400',
  color: '#ffffff'
}

/**
 * 默认搜索配置
 */
const defaultSearchConfig: BaseConfig['search'] = {
  show: true,
  default: 'baidu'
}

/**
 * 默认布局配置
 */
const defaultLayoutConfig: BaseConfig['layout'] = {
  view: 'widget',
  yiyan: true
}

/**
 * 默认图标配置
 */
const defaultIconConfig: BaseConfig['icon'] = {
  show: true,
  showAddIcon: true
}

/**
 * 默认壁纸配置
 */
const defaultWallpaperConfig: BaseConfig['wallpaper'] = {
  type: 0,
  src: '',
  thumb: '',
  mask: 0.3,
  blur: 0,
  switchBtn: false
}

/**
 * 默认基础配置
 */
const defaultBaseConfig: BaseConfig = {
  time: defaultTimeConfig,
  search: defaultSearchConfig,
  layout: defaultLayoutConfig,
  icon: defaultIconConfig,
  wallpaper: defaultWallpaperConfig
}

/**
 * 默认搜索引擎列表
 */
const defaultSearchEngines: SearchEngine[] = [
  {
    key: 'baidu',
    title: '百度',
    href: 'https://www.baidu.com/s?wd=',
    icon: 'https://files.codelife.cc/itab/search/baidu.svg'
  },
  {
    key: 'google',
    title: 'Google',
    href: 'https://www.google.com/search?q=',
    icon: 'https://files.codelife.cc/itab/search/google.svg'
  },
  {
    key: 'bing',
    title: '必应',
    href: 'https://www.bing.com/search?q=',
    icon: 'https://files.codelife.cc/itab/search/bing.svg'
  }
]

/**
 * 默认导航组
 */
const defaultNavGroups: NavGroup[] = [
  {
    id: 'default',
    name: '默认',
    children: [
      {
        id: 'baidu',
        name: '百度',
        url: 'https://www.baidu.com',
        type: 'icon',
        src: 'https://files.codelife.cc/itab/search/baidu.svg',
        backgroundColor: '#2932e1',
        size: '1x1'
      }
    ]
  }
]

// ==================== 状态 ====================

/**
 * 基础配置
 */
const baseConfig = ref<BaseConfig>({ ...defaultBaseConfig })

/**
 * 导航配置
 */
const navConfig = ref<NavConfig>({
  navGroups: defaultNavGroups
})

/**
 * 搜索引擎列表
 */
const searchEngines = ref<SearchEngine[]>([...defaultSearchEngines])

// ==================== 核心功能 ====================

/**
 * 配置管理 Hook
 */
export function useConfig() {
  const { isLoggedIn, uploadConfigToServer } = useUser()

  // ==================== 初始化 ====================

  /**
   * 初始化配置
   */
  async function initConfig() {
    // 加载基础配置
    await loadBaseConfig()

    // 加载导航配置
    await loadNavConfig()

    // 加载搜索引擎
    await loadSearchEngines()

    // 监听配置变化并自动保存
    watch(baseConfig, () => saveBaseConfig(), { deep: true })
    watch(navConfig, () => saveNavConfig(), { deep: true })
  }

  // ==================== 基础配置 ====================

  /**
   * 加载基础配置
   */
  async function loadBaseConfig(): Promise<void> {
    // 优先从 Chrome Storage 加载
    const chromeData = await chromeStorage.get('baseConfig')
    if (chromeData?.baseConfig) {
      baseConfig.value = mergeDefaultConfig(chromeData.baseConfig)
      return
    }

    // 从 IndexedDB 加载
    const localData = await indexdb.get<BaseConfig>('baseConfig')
    if (localData) {
      baseConfig.value = mergeDefaultConfig(localData)
    }
  }

  /**
   * 保存基础配置
   */
  async function saveBaseConfig(): Promise<void> {
    // 保存到 Chrome Storage (同步)
    try {
      await chromeStorage.set('baseConfig', baseConfig.value)
    } catch (error) {
      // Chrome Storage 不可用，保存到本地
      await indexdb.set('baseConfig', baseConfig.value)
    }

    // 保存到 IndexedDB
    await indexdb.set('baseConfig', baseConfig.value)

    // 如果已登录，同步到服务器
    if (isLoggedIn.value) {
      await uploadConfigToServer({ ...baseConfig.value, navConfig: navConfig.value })
    }
  }

  /**
   * 更新基础配置
   */
  async function updateBaseConfig(config: Partial<BaseConfig>): Promise<void> {
    baseConfig.value = {
      ...baseConfig.value,
      ...config
    }
    await saveBaseConfig()
  }

  /**
   * 重置基础配置
   */
  async function resetBaseConfig(): Promise<void> {
    baseConfig.value = { ...defaultBaseConfig }
    await saveBaseConfig()
  }

  // ==================== 导航配置 ====================

  /**
   * 加载导航配置
   */
  async function loadNavConfig(): Promise<void> {
    // 优先从 Chrome Storage 加载
    const chromeData = await chromeStorage.get('navConfig')
    if (chromeData?.navConfig) {
      navConfig.value = chromeData.navConfig
      return
    }

    // 从 IndexedDB 加载
    const localData = await indexdb.get<NavConfig>('navConfig')
    if (localData) {
      navConfig.value = localData
    }
  }

  /**
   * 保存导航配置
   */
  async function saveNavConfig(): Promise<void> {
    // 保存到 Chrome Storage
    try {
      await chromeStorage.set('navConfig', navConfig.value)
    } catch (error) {
      // Chrome Storage 不可用，保存到本地
      await indexdb.set('navConfig', navConfig.value)
    }

    // 保存到 IndexedDB
    await indexdb.set('navConfig', navConfig.value)

    // 如果已登录，同步到服务器
    if (isLoggedIn.value) {
      await uploadConfigToServer({ ...baseConfig.value, navConfig: navConfig.value })
    }
  }

  /**
   * 添加导航组
   */
  async function addNavGroup(group: NavGroup): Promise<void> {
    navConfig.value.navGroups.push(group)
    await saveNavConfig()
  }

  /**
   * 删除导航组
   */
  async function removeNavGroup(groupId: string): Promise<void> {
    const index = navConfig.value.navGroups.findIndex(g => g.id === groupId)
    if (index > -1) {
      navConfig.value.navGroups.splice(index, 1)
      await saveNavConfig()
    }
  }

  /**
   * 更新导航组
   */
  async function updateNavGroup(group: NavGroup): Promise<void> {
    const index = navConfig.value.navGroups.findIndex(g => g.id === group.id)
    if (index > -1) {
      navConfig.value.navGroups[index] = group
      await saveNavConfig()
    }
  }

  /**
   * 添加图标
   */
  async function addIcon(groupId: string, icon: IconItem): Promise<void> {
    const group = navConfig.value.navGroups.find(g => g.id === groupId)
    if (group) {
      group.children.push(icon)
      await saveNavConfig()
    }
  }

  /**
   * 删除图标
   */
  async function removeIcon(groupId: string, iconId: string): Promise<void> {
    const group = navConfig.value.navGroups.find(g => g.id === groupId)
    if (group) {
      const index = group.children.findIndex(i => i.id === iconId)
      if (index > -1) {
        group.children.splice(index, 1)
        await saveNavConfig()
      }
    }
  }

  /**
   * 更新图标
   */
  async function updateIcon(groupId: string, icon: IconItem): Promise<void> {
    const group = navConfig.value.navGroups.find(g => g.id === groupId)
    if (group) {
      const index = group.children.findIndex(i => i.id === icon.id)
      if (index > -1) {
        group.children[index] = icon
        await saveNavConfig()
      }
    }
  }

  // ==================== 搜索引擎 ====================

  /**
   * 加载搜索引擎
   */
  async function loadSearchEngines(): Promise<void> {
    const data = await indexdb.get<SearchEngine[]>('search-engines')
    if (data) {
      searchEngines.value = data
    }
  }

  /**
   * 保存搜索引擎
   */
  async function saveSearchEngines(): Promise<void> {
    await indexdb.set('search-engines', searchEngines.value)
  }

  /**
   * 添加搜索引擎
   */
  async function addSearchEngine(engine: SearchEngine): Promise<void> {
    searchEngines.value.push(engine)
    await saveSearchEngines()
  }

  /**
   * 删除搜索引擎
   */
  async function removeSearchEngine(key: string): Promise<void> {
    const index = searchEngines.value.findIndex(e => e.key === key)
    if (index > -1) {
      searchEngines.value.splice(index, 1)
      await saveSearchEngines()
    }
  }

  // ==================== 工具函数 ====================

  /**
   * 合并默认配置
   */
  function mergeDefaultConfig(config: Partial<BaseConfig>): BaseConfig {
    return {
      time: { ...defaultTimeConfig, ...config.time },
      search: { ...defaultSearchConfig, ...config.search },
      layout: { ...defaultLayoutConfig, ...config.layout },
      icon: { ...defaultIconConfig, ...config.icon },
      wallpaper: { ...defaultWallpaperConfig, ...config.wallpaper }
    }
  }

  /**
   * 导出配置
   */
  async function exportConfig(): Promise<string> {
    const config: AppConfig = {
      ...baseConfig.value,
      navConfig: navConfig.value
    }
    return JSON.stringify(config, null, 2)
  }

  /**
   * 导入配置
   */
  async function importConfig(jsonString: string): Promise<boolean> {
    try {
      const config = JSON.parse(jsonString) as AppConfig

      // 验证配置
      if (!config.time || !config.search || !config.layout) {
        throw new Error('无效的配置文件')
      }

      // 应用配置
      baseConfig.value = mergeDefaultConfig(config)
      if (config.navConfig) {
        navConfig.value = config.navConfig
      }

      // 保存
      await saveBaseConfig()
      await saveNavConfig()

      return true
    } catch (error) {
      console.error('导入配置失败:', error)
      return false
    }
  }

  // ==================== 返回 ====================

  return {
    // 状态
    baseConfig,
    navConfig,
    searchEngines,

    // 基础配置
    initConfig,
    loadBaseConfig,
    saveBaseConfig,
    updateBaseConfig,
    resetBaseConfig,

    // 导航配置
    loadNavConfig,
    saveNavConfig,
    addNavGroup,
    removeNavGroup,
    updateNavGroup,
    addIcon,
    removeIcon,
    updateIcon,

    // 搜索引擎
    loadSearchEngines,
    saveSearchEngines,
    addSearchEngine,
    removeSearchEngine,

    // 工具
    exportConfig,
    importConfig
  }
}

/**
 * X-Track Content Script - 浮动 UI 模块
 *
 * 负责在 Profile/Bookmarks/Likes 页面显示浮动抓取按钮
 */

import { detectPageType, startManualCollection, getScrapingStatus } from './scraping'
import { stopManualCollection } from './scraping'

/**
 * 浮动按钮状态
 */
type FloatingButtonState = 'idle' | 'collecting' | 'stopped'

/**
 * 浮动按钮类
 */
export class FloatingButton {
  private element: HTMLElement | null = null
  private state: FloatingButtonState = 'idle'
  private pageType: ReturnType<typeof detectPageType> = 'UNKNOWN'

  /**
   * 创建 SVG 图标元素
   */
  private createIcon(): SVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '24')
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5')
    svg.appendChild(path)

    return svg
  }

  /**
   * 创建浮动按钮
   */
  private createButton(): HTMLElement {
    const button = document.createElement('div')
    button.id = 'xtrack-floating-button'

    const icon = this.createIcon()
    const textSpan = document.createElement('span')
    textSpan.id = 'xtrack-button-text'
    textSpan.textContent = 'Start Scraping'

    button.appendChild(icon)
    button.appendChild(textSpan)

    // 样式
    this.applyStyles(button)

    // 悬停效果
    button.addEventListener('mouseenter', () => {
      if (this.element) {
        this.element.style.transform = 'translateY(-2px)'
        this.element.style.boxShadow = '0 6px 16px rgba(29, 155, 240, 0.4)'
      }
    })

    button.addEventListener('mouseleave', () => {
      if (this.element) {
        this.element.style.transform = 'translateY(0)'
        this.element.style.boxShadow = '0 4px 12px rgba(29, 155, 240, 0.3)'
      }
    })

    // 点击事件
    button.addEventListener('click', () => this.handleClick())

    return button
  }

  /**
   * 应用样式
   */
  private applyStyles(element: HTMLElement): void {
    Object.assign(element.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '10000',
      backgroundColor: '#1d9bf0',
      color: 'white',
      padding: '12px 20px',
      borderRadius: '24px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '14px',
      fontWeight: '600',
      boxShadow: '0 4px 12px rgba(29, 155, 240, 0.3)',
      transition: 'all 0.2s ease',
      userSelect: 'none'
    })
  }

  /**
   * 处理按钮点击
   */
  private handleClick(): void {
    if (this.state === 'idle') {
      this.startScraping()
    } else if (this.state === 'collecting') {
      this.stopScraping()
    } else {
      this.reset()
    }
  }

  /**
   * 开始抓取
   */
  private startScraping(): void {
    this.pageType = detectPageType()

    if (this.pageType === 'UNKNOWN') {
      this.showMessage('Not on a supported page')
      return
    }

    this.state = 'collecting'
    this.updateButton()

    startManualCollection(this.pageType)
    this.showMessage(`Scraping ${this.pageType}...`)
  }

  /**
   * 停止抓取
   */
  private stopScraping(): void {
    this.state = 'stopped'
    this.updateButton()

    const status = getScrapingStatus()
    stopManualCollection('User stopped via floating button')

    this.showMessage(`Collected ${status.totalScraped} tweets`)

    // 3秒后重置
    setTimeout(() => this.reset(), 3000)
  }

  /**
   * 重置按钮
   */
  private reset(): void {
    this.state = 'idle'
    this.pageType = 'UNKNOWN'
    this.updateButton()
  }

  /**
   * 更新按钮外观
   */
  private updateButton(): void {
    if (!this.element) return

    const textSpan = this.element.querySelector('#xtrack-button-text')
    if (!textSpan) return

    switch (this.state) {
      case 'idle':
        this.element.style.backgroundColor = '#1d9bf0'
        textSpan.textContent = 'Start Scraping'
        break
      case 'collecting':
        this.element.style.backgroundColor = '#ef4444'
        textSpan.textContent = 'Stop Scraping'
        break
      case 'stopped':
        this.element.style.backgroundColor = '#10b981'
        textSpan.textContent = 'Completed'
        break
    }
  }

  /**
   * 显示临时消息
   */
  private showMessage(message: string): void {
    if (!this.element) return

    const textSpan = this.element.querySelector('#xtrack-button-text')
    if (textSpan) {
      const originalText = textSpan.textContent || ''
      textSpan.textContent = message

      setTimeout(() => {
        textSpan.textContent = originalText
      }, 2000)
    }
  }

  /**
   * 显示按钮
   */
  show(): void {
    if (this.element) return

    this.element = this.createButton()
    document.body.appendChild(this.element)
    console.log('X-Track: Floating button shown')
  }

  /**
   * 隐藏按钮
   */
  hide(): void {
    if (this.element) {
      this.element.remove()
      this.element = null
      console.log('X-Track: Floating button hidden')
    }
  }

  /**
   * 销毁按钮
   */
  destroy(): void {
    this.hide()
    this.state = 'idle'
    this.pageType = 'UNKNOWN'
  }
}

/**
 * 全局浮动按钮实例
 */
let floatingButton: FloatingButton | null = null

/**
 * 检查当前页面是否应显示浮动按钮
 */
function shouldShowFloatingButton(): boolean {
  const pageType = detectPageType()
  return pageType !== 'UNKNOWN'
}

/**
 * 初始化浮动 UI
 */
export function initFloatingUI(): void {
  if (!floatingButton) {
    floatingButton = new FloatingButton()
  }

  // 检查是否应显示按钮
  if (shouldShowFloatingButton()) {
    floatingButton.show()
  }

  // 监听 URL 变化（SPA 导航）
  let lastUrl = location.href
  new MutationObserver(() => {
    const currentUrl = location.href
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl

      // 检查是否需要更新按钮显示
      if (shouldShowFloatingButton()) {
        if (!floatingButton?.['element']) {
          floatingButton?.show()
        }
      } else {
        floatingButton?.hide()
      }
    }
  }).observe(document.body, { childList: true, subtree: true })
}

/**
 * 销毁浮动 UI
 */
export function destroyFloatingUI(): void {
  floatingButton?.destroy()
  floatingButton = null
}

/**
 * 获取浮动按钮实例（用于外部控制）
 */
export function getFloatingButton(): FloatingButton | null {
  return floatingButton
}

/**
 * File Watch Service 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createDebouncer,
  EventAccumulator,
  MockFileWatcher,
  isPathInWatchScope,
  createFileChangeEvent,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_WATCH_DIRS,
} from '@/server/governance/services/file-watch'

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('延迟执行函数', () => {
    const fn = vi.fn()
    const { debounced } = createDebouncer(fn, 100)

    debounced()
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(99)
    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('多次调用只执行最后一次', () => {
    const fn = vi.fn()
    const { debounced } = createDebouncer(fn, 100)

    debounced()
    vi.advanceTimersByTime(50)
    debounced()
    vi.advanceTimersByTime(50)
    debounced()

    expect(fn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel 可以取消待执行的调用', () => {
    const fn = vi.fn()
    const { debounced, cancel } = createDebouncer(fn, 100)

    debounced()
    vi.advanceTimersByTime(50)
    cancel()
    vi.advanceTimersByTime(100)

    expect(fn).not.toHaveBeenCalled()
  })
})

describe('EventAccumulator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('累积事件并在去抖后批量触发', () => {
    const callback = vi.fn()
    const accumulator = new EventAccumulator(callback, 100)

    const event1 = createFileChangeEvent('add', 'file1.txt')
    const event2 = createFileChangeEvent('change', 'file2.txt')

    accumulator.push(event1)
    accumulator.push(event2)

    expect(callback).not.toHaveBeenCalled()
    expect(accumulator.pendingCount).toBe(2)

    vi.advanceTimersByTime(100)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith([event1, event2])
    expect(accumulator.pendingCount).toBe(0)
  })

  it('flush 立即触发回调', () => {
    const callback = vi.fn()
    const accumulator = new EventAccumulator(callback, 100)

    const event = createFileChangeEvent('add', 'file.txt')
    accumulator.push(event)
    accumulator.flush()

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith([event])
  })

  it('cancel 清除累积的事件', () => {
    const callback = vi.fn()
    const accumulator = new EventAccumulator(callback, 100)

    accumulator.push(createFileChangeEvent('add', 'file.txt'))
    accumulator.cancel()

    vi.advanceTimersByTime(100)

    expect(callback).not.toHaveBeenCalled()
    expect(accumulator.pendingCount).toBe(0)
  })

  it('空事件不触发回调', () => {
    const callback = vi.fn()
    const accumulator = new EventAccumulator(callback, 100)

    accumulator.flush()

    expect(callback).not.toHaveBeenCalled()
  })
})

describe('MockFileWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('初始状态为 idle', () => {
    const watcher = new MockFileWatcher()
    expect(watcher.status).toBe('idle')
  })

  it('start 后状态变为 watching', async () => {
    const watcher = new MockFileWatcher()
    await watcher.start()
    expect(watcher.status).toBe('watching')
  })

  it('stop 后状态变回 idle', async () => {
    const watcher = new MockFileWatcher()
    await watcher.start()
    await watcher.stop()
    expect(watcher.status).toBe('idle')
  })

  it('模拟文件变更触发回调', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    const callback = vi.fn()

    await watcher.start()
    watcher.onChange(callback)

    const event = createFileChangeEvent('change', 'test.txt')
    watcher.simulateChange(event)

    vi.advanceTimersByTime(100)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith([event])
  })

  it('未 start 时不触发回调', async () => {
    const watcher = new MockFileWatcher()
    const callback = vi.fn()

    watcher.onChange(callback)
    watcher.simulateChange(createFileChangeEvent('add', 'test.txt'))

    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS)

    expect(callback).not.toHaveBeenCalled()
  })

  it('模拟错误触发错误回调', async () => {
    const watcher = new MockFileWatcher()
    const errorCallback = vi.fn()

    await watcher.start()
    watcher.onError(errorCallback)

    const error = new Error('Test error')
    watcher.simulateError(error)

    expect(errorCallback).toHaveBeenCalledWith(error)
    expect(watcher.status).toBe('error')
  })

  it('取消订阅后不再收到回调', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    const callback = vi.fn()

    await watcher.start()
    const unsubscribe = watcher.onChange(callback)
    unsubscribe()

    watcher.simulateChange(createFileChangeEvent('add', 'test.txt'))
    vi.advanceTimersByTime(100)

    expect(callback).not.toHaveBeenCalled()
  })

  it('flushEvents 立即触发', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    const callback = vi.fn()

    await watcher.start()
    watcher.onChange(callback)

    watcher.simulateChange(createFileChangeEvent('add', 'test.txt'))
    watcher.flushEvents()

    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('isPathInWatchScope', () => {
  it('默认监听 .ggbdpq/actions', () => {
    expect(isPathInWatchScope('.ggbdpq/actions/prd.json')).toBe(true)
    expect(isPathInWatchScope('.ggbdpq/actions/progress.txt')).toBe(true)
    expect(isPathInWatchScope('.ggbdpq/actions/spec/prd.json')).toBe(true)
  })

  it('默认监听 .kiro/specs', () => {
    expect(isPathInWatchScope('.kiro/specs/requirements.md')).toBe(true)
    expect(isPathInWatchScope('.kiro/specs/design.md')).toBe(true)
  })

  it('不监听其他路径', () => {
    expect(isPathInWatchScope('src/main.ts')).toBe(false)
    expect(isPathInWatchScope('package.json')).toBe(false)
    expect(isPathInWatchScope('.git/HEAD')).toBe(false)
  })

  it('自定义监听目录', () => {
    expect(isPathInWatchScope('custom/path/file.txt', ['custom/path'])).toBe(true)
    expect(isPathInWatchScope('other/path/file.txt', ['custom/path'])).toBe(false)
  })

  it('处理 Windows 路径', () => {
    expect(isPathInWatchScope('.ggbdpq\\actions\\prd.json')).toBe(true)
  })
})

describe('createFileChangeEvent', () => {
  it('创建正确的事件结构', () => {
    const event = createFileChangeEvent('add', 'test.txt')

    expect(event.type).toBe('add')
    expect(event.path).toBe('test.txt')
    expect(event.timestamp).toBeInstanceOf(Date)
  })
})

describe('常量', () => {
  it('DEFAULT_DEBOUNCE_MS 为 500', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(500)
  })

  it('DEFAULT_WATCH_DIRS 包含正确的目录', () => {
    expect(DEFAULT_WATCH_DIRS).toContain('.ggbdpq/actions')
    expect(DEFAULT_WATCH_DIRS).toContain('.kiro/specs')
  })
})

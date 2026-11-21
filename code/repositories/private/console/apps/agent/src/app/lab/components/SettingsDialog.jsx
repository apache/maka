'use client'
// src/app/components/SettingsDialog.jsx —— 设置弹窗（原 settings.js 的 DOM 部分组件化）。
//
// 存取与连接测试在 utils/settings.js（纯逻辑）；这里只管表单。
// key 只存 localStorage；「测试连接」发一次 1-token 请求，顺带验证 CORS。
// 渐进披露：常用三项常驻，System Prompt / Compaction 折进「高级」。

import { useEffect, useRef, useState } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'
import { getSettings, saveSettings, normalizeSettings, testConnection } from '@ggbdpq/agent-lab-core/src/web-utils/settings.js'

const FIELDS = [
  { key: 'baseUrl', label: 'Base URL（OpenAI 兼容）', type: 'text', placeholder: 'https://api.openai.com/v1' },
  { key: 'apiKey', label: 'API Key（只存本机 localStorage）', type: 'password', placeholder: 'sk-…' },
  { key: 'model', label: 'Model', type: 'text', placeholder: 'gpt-4o-mini / glm-5.2 / …' },
]

const INPUT =
  'w-full rounded-chip border border-line bg-lab-base px-2.5 py-1.5 font-mono text-[12.5px] text-ink ' +
  'outline-none transition-colors placeholder:text-ink-faint focus:border-lab-accent'
const LABEL = 'mb-1 block text-[11px] text-ink-faint'

export default function SettingsDialog({ open, onClose }) {
  const dialogRef = useRef(null)
  const [form, setForm] = useState(getSettings)
  const [status, setStatus] = useState({ text: '', error: false, busy: false })

  // 每次打开回填当前设置（未保存的不带出来）
  useEffect(() => {
    if (open) {
      setForm(getSettings())
      setStatus({ text: '', error: false, busy: false })
      dialogRef.current?.showModal()
    } else {
      dialogRef.current?.close()
    }
  }, [open])

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const onSave = (e) => {
    e.preventDefault()
    saveSettings(normalizeSettings(form))
    onClose()
  }

  const onTest = async () => {
    const s = normalizeSettings(form) // 所见即所测：测试用表单里的值
    if (!s.apiKey) { setStatus({ text: '✗ 请先填写 API Key', error: true, busy: false }); return }
    setStatus({ text: '测试中…', error: false, busy: true })
    const r = await testConnection(s)
    setStatus({ text: r.message, error: !r.ok, busy: false })
  }

  return (
    <dialog
      ref={dialogRef}
      onCancel={onClose}
      className="w-[min(92vw,540px)] rounded-panel m-auto border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-lab-base/70 backdrop:backdrop-blur-sm"
    >
      <form className="p-5" method="dialog" onSubmit={onSave}>
        <h2 className="mb-4 text-sm font-semibold tracking-wide">设置</h2>

        <div className="grid gap-3.5">
          {FIELDS.map(f => (
            <label key={f.key} className="block">
              <span className={LABEL}>{f.label}</span>
              <input className={INPUT} type={f.type} placeholder={f.placeholder} value={form[f.key]} onChange={set(f.key)} />
            </label>
          ))}
        </div>

        {/* 高级设置（渐进披露）：改 system prompt / 压缩阈值才需要打开 */}
        <details className="mt-2 border-t border-line-soft">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 py-2.5 text-[11.5px] text-ink-faint transition-colors hover:text-ink-dim [&::-webkit-details-marker]:hidden">
            <CaretRightIcon size={11} className="transition-transform open:rotate-90" />
            高级：System Prompt 与 Compaction
          </summary>
          <div className="grid gap-3.5 pb-1.5">
            <label className="block">
              <span className={LABEL}>System Prompt</span>
              <textarea className={`${INPUT} resize-y leading-relaxed`} rows={4} value={form.systemPrompt} onChange={set('systemPrompt')} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={LABEL}>Compaction 阈值（消息数达到即触发压缩）</span>
                <input className={INPUT} type="number" min={3} max={500} step={1} value={form.compactThreshold} onChange={set('compactThreshold')} />
              </label>
              <label className="block">
                <span className={LABEL}>压缩时保留最近消息条数</span>
                <input className={INPUT} type="number" min={1} max={200} step={1} value={form.keepRecent} onChange={set('keepRecent')} />
              </label>
            </div>
            <p className="-mt-1.5 text-[11px] leading-relaxed text-ink-faint">演示 compaction 可把阈值调低（如 8/4），多聊几轮把消息推过阈值。</p>
          </div>
        </details>

        <div className={`mt-1 min-h-[18px] text-[11.5px] ${status.error ? 'text-red' : 'text-ink-faint'}`} aria-live="polite">{status.text}</div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            className="rounded-chip border border-line bg-raised px-3 py-1.5 text-xs text-ink-dim transition-colors hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            type="button"
            id="settings-test"
            onClick={onTest}
            disabled={status.busy}
          >测试连接</button>
          <button
            className="rounded-chip px-3 py-1.5 text-xs text-ink-faint transition-colors hover:text-ink"
            type="button"
            onClick={onClose}
          >取消</button>
          <button
            className="rounded-chip border border-lab-accent/45 bg-lab-accent-soft px-3.5 py-1.5 text-xs font-medium text-lab-accent transition-colors hover:bg-lab-accent/15"
            type="submit"
          >保存</button>
        </div>
      </form>
    </dialog>
  )
}

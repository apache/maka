import { afterEach, describe, expect, it } from 'vitest'
import { ApiRequestError, apiFetch } from './api-fetch'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const stubFetch = (impl: () => Promise<Response>) => {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

describe('apiFetch', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  it('2xx 返回解析后的 JSON', async () => {
    cleanups.push(stubFetch(async () => json({ ok: true, value: 42 })))
    expect(await apiFetch<{ value: number }>('/x')).toEqual({ ok: true, value: 42 })
  })

  it('204 返回 undefined', async () => {
    cleanups.push(stubFetch(async () => new Response(null, { status: 204 })))
    expect(await apiFetch('/x')).toBeUndefined()
  })

  it('非 2xx 且响应体为错误封套时，抛带 code/status 的 ApiRequestError', async () => {
    cleanups.push(stubFetch(async () => json({ code: 'CONFLICT', message: 'URL 已存在' }, 409)))
    const err = await apiFetch('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).code).toBe('CONFLICT')
    expect((err as ApiRequestError).status).toBe(409)
    expect((err as ApiRequestError).message).toBe('URL 已存在')
  })

  it('非 2xx 且响应体不可解析时，抛兜底 INTERNAL_ERROR', async () => {
    cleanups.push(stubFetch(async () => new Response('<html>boom</html>', { status: 500 })))
    const err = await apiFetch('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).code).toBe('INTERNAL_ERROR')
  })
})

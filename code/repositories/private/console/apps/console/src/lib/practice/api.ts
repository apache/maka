import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PracticeData, PracticeSyncRequest, PracticeSyncResponse } from '@ggbdpq/console-shared'

async function fetchPracticeData(): Promise<PracticeData> {
  const res = await fetch('/api/practice/data')
  if (!res.ok) {
    const raw = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(raw?.message ?? `读取实践数据失败（HTTP ${res.status}）`)
  }
  return res.json() as Promise<PracticeData>
}

export function usePracticeData() {
  return useQuery({ queryKey: ['practice', 'data'], queryFn: fetchPracticeData })
}

export function usePracticeSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (req?: PracticeSyncRequest): Promise<PracticeSyncResponse> => {
      const res = await fetch('/api/practice/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req ?? {}),
      })
      if (!res.ok) {
        const raw = (await res.json().catch(() => null)) as { message?: string } | null
        throw new Error(raw?.message ?? `同步失败（HTTP ${res.status}）`)
      }
      return res.json() as Promise<PracticeSyncResponse>
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['practice', 'data'] })
    },
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BatchRequest,
  BatchResult,
  BookmarkListResponse,
  BookmarkView,
  CategoryStat,
  CreateBookmarkInput,
  DuplicatesResponse,
  ImportPreview,
  ImportRequest,
  ImportResult,
  UpdateBookmarkInput,
} from '@ggbdpq/console-shared/bookmarks'
import { api } from './client'

const KEY = ['bookmarks'] as const

export interface BookmarkListParams {
  q?: string
  category?: string
  view?: BookmarkView
  limit?: number
  offset?: number
}

function listQueryString(params: BookmarkListParams): string {
  const sp = new URLSearchParams()
  if (params.q) sp.set('q', params.q)
  if (params.category) sp.set('category', params.category)
  if (params.view) sp.set('view', params.view)
  sp.set('limit', String(params.limit ?? 200))
  sp.set('offset', String(params.offset ?? 0))
  return sp.toString()
}

export function useBookmarks(params: BookmarkListParams) {
  return useQuery({
    queryKey: [...KEY, 'list', params],
    queryFn: () => api<BookmarkListResponse>(`/api/bookmarks/bookmarks?${listQueryString(params)}`),
  })
}

export function useCategories() {
  return useQuery({
    queryKey: [...KEY, 'categories'],
    queryFn: () => api<{ categories: CategoryStat[] }>('/api/bookmarks/categories'),
  })
}

export function useDuplicates(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'duplicates'],
    queryFn: () => api<DuplicatesResponse>('/api/bookmarks/duplicates'),
    enabled,
  })
}

export function useCreateBookmark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBookmarkInput) =>
      api('/api/bookmarks/bookmarks', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateBookmark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateBookmarkInput & { id: number }) =>
      api(`/api/bookmarks/bookmarks/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteBookmark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, purge }: { id: number; purge?: boolean }) =>
      api<void>(`/api/bookmarks/bookmarks/${id}${purge ? '?purge=true' : ''}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useRestoreBookmark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      api(`/api/bookmarks/bookmarks/${id}/restore`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useBatchBookmarks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: BatchRequest) =>
      api<BatchResult>('/api/bookmarks/batch', { method: 'POST', body: JSON.stringify(req) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

/** confirm=false 返回 ImportPreview，confirm=true 返回 ImportResult（调用方按 flags 区分） */
export function useImportBookmarks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: ImportRequest) =>
      api<ImportPreview | ImportResult>('/api/bookmarks/import', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
    onSuccess: (_, variables) => {
      if (variables.confirm) qc.invalidateQueries({ queryKey: KEY })
    },
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Conversation } from '@ggbdpq/console-shared/todo'
import { api } from './client'

const KEY = ['conversations'] as const

export function useConversations() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<Conversation[]>('/api/todo/conversations'),
  })
}

export function useDeleteConversation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/todo/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

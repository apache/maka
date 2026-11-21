import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateTodoInput, Todo, UpdateTodoInput } from '@ggbdpq/console-shared/todo'
import { api } from './client'

const KEY = ['todos'] as const

export function useTodos() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<Todo[]>('/api/todo/todos'),
  })
}

export function useCreateTodo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTodoInput) => api<Todo>('/api/todo/todos', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useUpdateTodo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTodoInput & { id: number }) =>
      api<Todo>(`/api/todo/todos/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteTodo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/todo/todos/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

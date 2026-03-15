import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { IRepository } from '@/core/repositories'
import { useAuthStore } from '@/stores/auth-store'

export function useRepository<T extends { id: string }>(
  key: string,
  repository: IRepository<T>,
) {
  const queryClient = useQueryClient()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  const { data: items = [], isLoading } = useQuery({
    queryKey: [key],
    queryFn: () => repository.getAll(),
    enabled: isAuthenticated,
    retry: false,
  })

  const create = useMutation({
    mutationFn: (item: T) => repository.create(item),
    onMutate: async (newItem) => {
      await queryClient.cancelQueries({ queryKey: [key] })
      const previous = queryClient.getQueryData<T[]>([key])
      queryClient.setQueryData<T[]>([key], (old = []) => [...old, newItem])
      return { previous }
    },
    onError: (_err, _item, context) => {
      if (context?.previous) queryClient.setQueryData([key], context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  const update = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<T> }) =>
      repository.update(id, updates),
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey: [key] })
      const previous = queryClient.getQueryData<T[]>([key])
      queryClient.setQueryData<T[]>([key], (old = []) =>
        old.map((item) => (item.id === id ? { ...item, ...updates } : item)),
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData([key], context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => repository.delete(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: [key] })
      const previous = queryClient.getQueryData<T[]>([key])
      queryClient.setQueryData<T[]>([key], (old = []) =>
        old.filter((item) => item.id !== id),
      )
      return { previous }
    },
    onError: (_err, _id, context) => {
      if (context?.previous) queryClient.setQueryData([key], context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  return { items, isLoading, create, update, remove }
}

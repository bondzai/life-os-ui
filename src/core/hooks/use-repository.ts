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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [key] })

  const create = useMutation({
    mutationFn: (item: T) => repository.create(item),
    onSuccess: invalidate,
  })

  const update = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<T> }) =>
      repository.update(id, updates),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (id: string) => repository.delete(id),
    onSuccess: invalidate,
  })

  return { items, isLoading, create, update, remove }
}

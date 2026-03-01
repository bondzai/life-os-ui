import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { IRepository } from '@/core/repositories'

export function useRepository<T extends { id: string }>(
  key: string,
  repository: IRepository<T>,
) {
  const queryClient = useQueryClient()

  const { data: items = [], isLoading } = useQuery({
    queryKey: [key],
    queryFn: () => repository.getAll(),
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

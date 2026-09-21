import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { IRepository } from '@/core/repositories'
import { useAuthStore } from '@/stores/auth-store'

/**
 * Fetch a subset of a collection under its own cache entry.
 *
 * Without one, every consumer of a resource shares a single cache entry holding the whole table —
 * which for `entities` means every task, note, comment and transaction, with their metadata blobs,
 * fetched and re-parsed on each mutation. A scope gives the caller its own slice and its own key.
 */
export interface RepositoryScope<T> {
  /** Appended to the query key, so each scope caches separately. */
  scope: string
  /** Fetch just this slice. The server filter, where there is one. */
  fetch: () => Promise<T[]>
}

export function useRepository<T extends { id: string }>(
  key: string,
  repository: IRepository<T>,
  scope?: RepositoryScope<T>,
) {
  const queryClient = useQueryClient()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  // Optimistic writes land on the scope the caller is actually reading. Invalidation stays on the
  // bare `[key]`, which TanStack treats as a prefix — so one create refreshes every other scope
  // *and* the unscoped whole-collection readers, and no page is left holding a stale list.
  const queryKey = scope ? [key, scope.scope] : [key]

  const { data: items = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => (scope ? scope.fetch() : repository.getAll()),
    enabled: isAuthenticated,
    retry: false,
  })

  const create = useMutation({
    mutationFn: (item: T) => repository.create(item),
    onMutate: async (newItem) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<T[]>(queryKey)
      queryClient.setQueryData<T[]>(queryKey, (old = []) => [...old, newItem])
      return { previous }
    },
    onError: (_err, _item, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  const update = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<T> }) =>
      repository.update(id, updates),
    onMutate: async ({ id, updates }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<T[]>(queryKey)
      queryClient.setQueryData<T[]>(queryKey, (old = []) =>
        old.map((item) => (item.id === id ? { ...item, ...updates } : item)),
      )
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => repository.delete(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<T[]>(queryKey)
      queryClient.setQueryData<T[]>(queryKey, (old = []) =>
        old.filter((item) => item.id !== id),
      )
      return { previous }
    },
    onError: (_err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [key] }),
  })

  return { items, isLoading, create, update, remove }
}

/**
 * Notification channels and the routing matrix.
 *
 * Two queries and four mutations over `/api/channels` and `/api/routes`. The shapes mirror
 * `lyra_db::channels`, with one asymmetry that is the point of the whole design: **a channel comes
 * back with a `preview`, never a credential, and a credential goes out and is never read back.**
 * That is why `url` is optional on an update — the form was never given the old value, so absence is
 * the only way it can say "leave it alone".
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

export type Severity = 'info' | 'warning' | 'critical'

export interface Channel {
  id: string
  name: string
  transport: string
  /** Host, webhook id, and the last four of the token. Enough to tell two rooms apart. */
  preview: string | null
  /** Whether the credential is in this row, or comes from `.env.local`. */
  stored_secret: boolean
  enabled: boolean
  last_error: string | null
  /** Unix seconds since the first failure that has not been followed by a success. */
  failing_since: number | null
}

export interface TransportKind {
  id: string
  stores_credential: boolean
}

export interface Route {
  id: string
  group: string
  channel_id: string
  min_severity: Severity
  /** Local hours. Both null means no quiet hours; the range may wrap past midnight. */
  quiet_from: number | null
  quiet_to: number | null
}

interface ChannelsResponse {
  channels: Channel[]
  transports: TransportKind[]
}

interface RoutesResponse {
  routes: Route[]
  groups: string[]
  severities: Severity[]
}

/** What a route looks like before it has been saved and given an id. */
export type RouteDraft = Omit<Route, 'id'>

export function useChannels() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<ChannelsResponse>({
    queryKey: ['channels'],
    enabled: isAuthenticated,
    queryFn: () => apiGet<ChannelsResponse>('channels'),
  })
}

export function useRoutes() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  return useQuery<RoutesResponse>({
    queryKey: ['routes'],
    enabled: isAuthenticated,
    queryFn: () => apiGet<RoutesResponse>('routes'),
  })
}

export function useCreateChannel() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; transport: string; url?: string }) =>
      apiSend<Channel>('POST', 'channels', body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useUpdateChannel() {
  const client = useQueryClient()
  return useMutation({
    // `url` omitted leaves the stored credential alone. Sending `url: ''` would be a different
    // request, and the server treats an empty string as absent for the same reason.
    mutationFn: ({
      id,
      ...body
    }: {
      id: string
      name?: string
      url?: string
      enabled?: boolean
    }) => apiSend<Channel>('PATCH', `channels/${encodeURIComponent(id)}`, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useDeleteChannel() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiSend<unknown>('DELETE', `channels/${encodeURIComponent(id)}`),
    onSuccess: () =>
      // Routes too: deleting a channel cascades, so a stale matrix would show a column that no
      // longer exists.
      Promise.all([
        client.invalidateQueries({ queryKey: ['channels'] }),
        client.invalidateQueries({ queryKey: ['routes'] }),
      ]),
  })
}

/**
 * Send the "is this thing on?" ping.
 *
 * The result is recorded server-side, so a failure shows up in `last_error` on the next read — which
 * is why this invalidates rather than just returning.
 */
export function useTestChannel() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiSend<unknown>('POST', `channels/${encodeURIComponent(id)}/test`),
    onSettled: () => client.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useSaveRoutes() {
  const client = useQueryClient()
  return useMutation({
    // The whole matrix, because it is edited as one. A per-cell save could half-apply and leave a
    // group delivering to a channel that had just been unticked.
    mutationFn: (routes: RouteDraft[]) => apiSend<unknown>('PUT', 'routes', { routes }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['routes'] }),
  })
}

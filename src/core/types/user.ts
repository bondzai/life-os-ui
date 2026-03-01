export type UserRole = 'admin' | 'member'

export interface User {
  id: string
  name: string
  role: UserRole
  pin: string
  avatarUrl?: string
}

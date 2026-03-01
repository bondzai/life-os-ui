import { EmptyState } from '@/core/components/empty-state'
import type { LucideIcon } from 'lucide-react'

interface StubPageProps {
  title: string
  icon: LucideIcon
}

export function StubPage({ title, icon }: StubPageProps) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description="Coming soon. This module is under development."
    />
  )
}

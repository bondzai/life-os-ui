import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useMorningBrief } from './use-morning-brief'
import { lyraLog } from '@/stores/lyra-log-store'
import { useAIStore } from '@/stores/ai-store'

const PULSE_INTERVAL = 10 * 60 * 1000 // 10 minutes

export function useLyraPulse() {
  const insights = useMorningBrief()
  const notificationLevel = useAIStore((s) => s.notificationLevel)
  const shownIds = useRef(new Set<string>())
  const lastDate = useRef(new Date().toISOString().split('T')[0])

  useEffect(() => {
    if (notificationLevel === 'off') return

    const check = () => {
      // Reset daily
      const today = new Date().toISOString().split('T')[0]
      if (today !== lastDate.current) {
        shownIds.current.clear()
        lastDate.current = today
      }

      // minimal = only severity 3 (critical), full = severity 2+
      const minSeverity = notificationLevel === 'minimal' ? 3 : 2

      // Fire toasts for new critical insights
      for (const insight of insights) {
        if (insight.severity >= minSeverity && !shownIds.current.has(insight.id)) {
          shownIds.current.add(insight.id)
          lyraLog({ level: 'action', source: 'pulse', message: insight.title, detail: insight.detail })
          toast(insight.title, {
            description: insight.detail,
            action: insight.actionPath
              ? {
                  label: insight.actionLabel ?? 'View',
                  onClick: () => {
                    window.location.href = insight.actionPath!
                  },
                }
              : undefined,
            duration: 8000,
          })
        }
      }
    }

    // Initial check after 5 second delay (let app settle)
    const initTimer = setTimeout(check, 5000)
    const interval = setInterval(check, PULSE_INTERVAL)

    return () => {
      clearTimeout(initTimer)
      clearInterval(interval)
    }
  }, [insights, notificationLevel])
}

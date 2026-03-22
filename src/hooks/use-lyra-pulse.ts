import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useMorningBrief } from './use-morning-brief'

const PULSE_INTERVAL = 10 * 60 * 1000 // 10 minutes

export function useLyraPulse() {
  const insights = useMorningBrief()
  const shownIds = useRef(new Set<string>())
  const lastDate = useRef(new Date().toISOString().split('T')[0])

  useEffect(() => {
    const check = () => {
      // Reset daily
      const today = new Date().toISOString().split('T')[0]
      if (today !== lastDate.current) {
        shownIds.current.clear()
        lastDate.current = today
      }

      // Fire toasts for new critical insights
      for (const insight of insights) {
        if (insight.severity >= 2 && !shownIds.current.has(insight.id)) {
          shownIds.current.add(insight.id)
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
  }, [insights])
}

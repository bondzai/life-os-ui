import { Sparkles } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

const AFFIRMATIONS = [
  "You are capable of achieving great things.",
  "Every small step counts toward your bigger goals.",
  "Today is a fresh opportunity to grow.",
  "Your consistency will pay off.",
  "Progress, not perfection.",
  "You have the power to create change.",
  "Believe in the process.",
  "One day at a time, one task at a time.",
  "Your effort today shapes your tomorrow.",
  "Stay focused, stay positive.",
  "You are stronger than you think.",
  "Great things take time — keep going.",
  "Your potential is limitless.",
  "Embrace the journey, not just the destination.",
  "Small wins build big victories.",
  "You are making progress, even when it doesn't feel like it.",
  "Today matters. Make it count.",
  "Your dedication is inspiring.",
  "Trust yourself — you've got this.",
  "The best time to start is now.",
  "Discipline is the bridge between goals and accomplishment.",
  "You are exactly where you need to be.",
  "Every day is a chance to be better than yesterday.",
  "Keep pushing — breakthroughs are just ahead.",
  "Your hard work is building something meaningful.",
  "Stay patient and stay persistent.",
  "You are worthy of your dreams.",
  "Focus on what you can control.",
  "Celebrate how far you've come.",
  "Tomorrow's success starts with today's effort.",
]

function getAffirmationForDate(): string {
  const today = new Date()
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000,
  )
  return AFFIRMATIONS[dayOfYear % AFFIRMATIONS.length]
}

export function DailyAffirmation() {
  const quote = getAffirmationForDate()

  return (
    <Card className="border-dashed border-primary/20">
      <CardContent className="p-3 flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-yellow-500 shrink-0" />
        <p className="text-sm italic text-muted-foreground">{quote}</p>
      </CardContent>
    </Card>
  )
}

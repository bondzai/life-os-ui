import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckSquare, Target, Repeat, Plus } from 'lucide-react'

const widgets = [
  { title: "Today's Tasks", icon: CheckSquare, description: 'Your tasks for today will appear here.' },
  { title: 'Goal Progress', icon: Target, description: 'Track progress on active goals.' },
  { title: 'Habits', icon: Repeat, description: 'Daily habit check-ins show here.' },
  { title: 'Quick Add', icon: Plus, description: 'Quickly create new entities.' },
]

export function DashboardPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {widgets.map((widget) => (
        <Card key={widget.title}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <widget.icon className="h-4 w-4 text-muted-foreground" />
              {widget.title}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{widget.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

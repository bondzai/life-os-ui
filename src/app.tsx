import { BrowserRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/theme-provider'
import { AppLayout } from '@/layout/app-layout'
import { ProtectedRoute } from '@/layout/protected-route'
import { LoginPage } from '@/pages/login'
import { DashboardPage } from '@/pages/dashboard'
import { GoalsPage } from '@/pages/goals'
import { TasksPage } from '@/pages/tasks'
import { CalendarPage } from '@/pages/calendar'
import { NotFoundPage } from '@/pages/not-found'
import { HabitsPage } from '@/pages/habits'
import { SkillsPage } from '@/pages/skills'
import { ReadingPage } from '@/pages/reading'
import { NotesPage } from '@/pages/notes'
import { PostsPage } from '@/pages/posts'
import { NotificationsPage } from '@/pages/notifications'
import { PlacesPage } from '@/pages/places'
import { TravelPage } from '@/pages/travel'
import { WealthPage } from '@/pages/wealth'
import { HealthPage } from '@/pages/health'
import {
  HomePage,
  FamilyPage,
} from '@/pages/stubs'

const queryClient = new QueryClient()

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="goals" element={<GoalsPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="notes" element={<NotesPage />} />
                  <Route path="skills" element={<SkillsPage />} />
                  <Route path="habits" element={<HabitsPage />} />
                  <Route path="reading" element={<ReadingPage />} />
                  <Route path="posts" element={<PostsPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="places" element={<PlacesPage />} />
                  <Route path="travel" element={<TravelPage />} />
                  <Route path="health" element={<HealthPage />} />
                  <Route path="wealth" element={<WealthPage />} />
                  <Route path="home" element={<HomePage />} />
                  <Route path="family" element={<FamilyPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
          <Toaster position="bottom-right" richColors />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

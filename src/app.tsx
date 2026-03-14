import { lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/theme-provider'
import { AppLayout } from '@/layout/app-layout'
import { ProtectedRoute } from '@/layout/protected-route'
import { LoginPage } from '@/pages/login'
import { NotFoundPage } from '@/pages/not-found'

// Lazy-loaded pages for code splitting
const TodayPage = lazy(() => import('@/pages/today').then((m) => ({ default: m.TodayPage })))
const GoalsPage = lazy(() => import('@/pages/goals').then((m) => ({ default: m.GoalsPage })))
const TasksPage = lazy(() => import('@/pages/tasks').then((m) => ({ default: m.TasksPage })))
const CalendarPage = lazy(() => import('@/pages/calendar').then((m) => ({ default: m.CalendarPage })))
const HabitsPage = lazy(() => import('@/pages/habits').then((m) => ({ default: m.HabitsPage })))
const SkillsPage = lazy(() => import('@/pages/skills').then((m) => ({ default: m.SkillsPage })))
const ReadingPage = lazy(() => import('@/pages/reading').then((m) => ({ default: m.ReadingPage })))
const NotesPage = lazy(() => import('@/pages/notes').then((m) => ({ default: m.NotesPage })))
const PostsPage = lazy(() => import('@/pages/posts').then((m) => ({ default: m.PostsPage })))
const NotificationsPage = lazy(() => import('@/pages/notifications').then((m) => ({ default: m.NotificationsPage })))
const PlacesPage = lazy(() => import('@/pages/places').then((m) => ({ default: m.PlacesPage })))
const TravelPage = lazy(() => import('@/pages/travel').then((m) => ({ default: m.TravelPage })))
const WealthPage = lazy(() => import('@/pages/wealth').then((m) => ({ default: m.WealthPage })))
const HealthPage = lazy(() => import('@/pages/health').then((m) => ({ default: m.HealthPage })))
const HomePage = lazy(() => import('@/pages/home').then((m) => ({ default: m.HomePage })))
const FamilyPage = lazy(() => import('@/pages/family').then((m) => ({ default: m.FamilyPage })))
const AutomatePage = lazy(() => import('@/pages/automate').then((m) => ({ default: m.AutomatePage })))
const MemoriesPage = lazy(() => import('@/pages/memories').then((m) => ({ default: m.MemoriesPage })))
const ReviewPage = lazy(() => import('@/pages/review').then((m) => ({ default: m.ReviewPage })))
const LiveLocationPage = lazy(() => import('@/pages/live-location').then((m) => ({ default: m.LiveLocationPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
})

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
                  <Route index element={<TodayPage />} />
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
                  <Route path="automate" element={<AutomatePage />} />
                  <Route path="memories" element={<MemoriesPage />} />
                  <Route path="today" element={<TodayPage />} /> {/* keep for backward compat */}
                  <Route path="location" element={<LiveLocationPage />} />
                  <Route path="review" element={<ReviewPage />} />
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

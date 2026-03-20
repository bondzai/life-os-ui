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
const LearningPage = lazy(() => import('@/pages/learning').then((m) => ({ default: m.LearningPage })))
const NotesPage = lazy(() => import('@/pages/notes').then((m) => ({ default: m.NotesPage })))
const TravelPage = lazy(() => import('@/pages/places').then((m) => ({ default: m.PlacesPage })))
const WealthPage = lazy(() => import('@/pages/wealth').then((m) => ({ default: m.WealthPage })))
const HealthPage = lazy(() => import('@/pages/health').then((m) => ({ default: m.HealthPage })))
const FamilyPage = lazy(() => import('@/pages/family').then((m) => ({ default: m.FamilyPage })))
const ReviewPage = lazy(() => import('@/pages/review').then((m) => ({ default: m.ReviewPage })))
const DashboardPage = lazy(() => import('@/pages/dashboard').then((m) => ({ default: m.DashboardPage })))
const NotificationsPage = lazy(() => import('@/pages/notifications').then((m) => ({ default: m.NotificationsPage })))
const DeepWorkPage = lazy(() => import('@/pages/deep-work').then((m) => ({ default: m.DeepWorkPage })))
const SessionsPage = lazy(() => import('@/pages/sessions').then((m) => ({ default: m.SessionsPage })))
const InboxPage = lazy(() => import('@/pages/inbox').then((m) => ({ default: m.InboxPage })))
const BriefingPage = lazy(() => import('@/pages/tasks/standup-report').then((m) => ({ default: m.BriefingPage })))

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
                <Route path="deep-work" element={<DeepWorkPage />} />
                <Route path="briefing" element={<BriefingPage />} />
                <Route element={<AppLayout />}>
                  <Route index element={<TodayPage />} />
                  <Route path="goals" element={<GoalsPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="notes" element={<NotesPage />} />
                  <Route path="habits" element={<HabitsPage />} />
                  <Route path="learning" element={<LearningPage />} />
                  <Route path="health" element={<HealthPage />} />
                  <Route path="wealth" element={<WealthPage />} />
                  <Route path="travel" element={<TravelPage />} />
                  <Route path="family" element={<FamilyPage />} />
                  <Route path="review" element={<ReviewPage />} />
                  <Route path="sessions" element={<SessionsPage />} />
                  <Route path="inbox" element={<InboxPage />} />
                  <Route path="dashboard" element={<DashboardPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="today" element={<TodayPage />} />
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

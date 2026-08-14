import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
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
const NotesPage = lazy(() => import('@/pages/notes').then((m) => ({ default: m.NotesPage })))
const ReviewPage = lazy(() => import('@/pages/review').then((m) => ({ default: m.ReviewPage })))
const DashboardPage = lazy(() => import('@/pages/dashboard').then((m) => ({ default: m.DashboardPage })))
const NotificationsPage = lazy(() => import('@/pages/notifications').then((m) => ({ default: m.NotificationsPage })))
const DeepWorkPage = lazy(() => import('@/pages/deep-work').then((m) => ({ default: m.DeepWorkPage })))
const InboxPage = lazy(() => import('@/pages/inbox').then((m) => ({ default: m.InboxPage })))
const BriefingPage = lazy(() => import('@/pages/tasks/standup-report').then((m) => ({ default: m.BriefingPage })))
const SettingsPage = lazy(() => import('@/pages/settings').then((m) => ({ default: m.SettingsPage })))
const KnowledgePage = lazy(() => import('@/pages/knowledge').then((m) => ({ default: m.KnowledgePage })))
const WealthOverviewPage = lazy(() => import('@/pages/wealth/overview').then((m) => ({ default: m.WealthOverviewPage })))
const WealthHoldingsPage = lazy(() => import('@/pages/wealth/holdings').then((m) => ({ default: m.WealthHoldingsPage })))
const WealthDefiPage = lazy(() => import('@/pages/wealth/defi').then((m) => ({ default: m.WealthDefiPage })))


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
                <Route path="deep-work" element={<Suspense fallback={null}><DeepWorkPage /></Suspense>} />
                <Route path="briefing" element={<Suspense fallback={null}><BriefingPage /></Suspense>} />
                <Route element={<AppLayout />}>
                  <Route index element={<TodayPage />} />
                  <Route path="projects" element={<Navigate to="/goals" replace />} />
                  <Route path="goals" element={<GoalsPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="notes" element={<NotesPage />} />
                  <Route path="habits" element={<HabitsPage />} />
                  <Route path="review" element={<ReviewPage />} />
                  <Route path="inbox" element={<InboxPage />} />
                  <Route path="dashboard" element={<DashboardPage />} />
                  <Route path="notifications" element={<NotificationsPage />} />
                  <Route path="knowledge" element={<Suspense fallback={null}><KnowledgePage /></Suspense>} />
                  {/* Wealth — lazy, so the crypto surfaces stay out of the initial bundle. */}
                  <Route path="wealth" element={<Suspense fallback={null}><WealthOverviewPage /></Suspense>} />
                  <Route path="wealth/holdings" element={<Suspense fallback={null}><WealthHoldingsPage /></Suspense>} />
                  <Route path="wealth/defi" element={<Suspense fallback={null}><WealthDefiPage /></Suspense>} />
                  <Route path="settings" element={<SettingsPage />} />

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

import { BrowserRouter, Routes, Route } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/components/theme-provider'
import { AppLayout } from '@/layout/app-layout'
import { ProtectedRoute } from '@/layout/protected-route'
import { LoginPage } from '@/pages/login'
import { DashboardPage } from '@/pages/dashboard'
import { NotFoundPage } from '@/pages/not-found'
import {
  GoalsPage,
  TasksPage,
  CalendarPage,
  SkillsPage,
  HabitsPage,
  HealthPage,
  WealthPage,
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
                  <Route path="skills" element={<SkillsPage />} />
                  <Route path="habits" element={<HabitsPage />} />
                  <Route path="health" element={<HealthPage />} />
                  <Route path="wealth" element={<WealthPage />} />
                  <Route path="home" element={<HomePage />} />
                  <Route path="family" element={<FamilyPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

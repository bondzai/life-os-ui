import { Target, CheckSquare, Calendar, Brain, Repeat, Heart, Wallet, Home, Users } from 'lucide-react'
import { StubPage } from './stub-page'

export const GoalsPage = () => <StubPage title="Goals" icon={Target} />
export const TasksPage = () => <StubPage title="Tasks" icon={CheckSquare} />
export const CalendarPage = () => <StubPage title="Calendar" icon={Calendar} />
export const SkillsPage = () => <StubPage title="Skills" icon={Brain} />
export const HabitsPage = () => <StubPage title="Habits" icon={Repeat} />
export const HealthPage = () => <StubPage title="Health" icon={Heart} />
export const WealthPage = () => <StubPage title="Wealth" icon={Wallet} />
export const HomePage = () => <StubPage title="Home" icon={Home} />
export const FamilyPage = () => <StubPage title="Family" icon={Users} />

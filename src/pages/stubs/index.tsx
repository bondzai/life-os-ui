import { Brain, Repeat, Heart, Wallet, Home, Users } from 'lucide-react'
import { StubPage } from './stub-page'

export const SkillsPage = () => <StubPage title="Skills" icon={Brain} />
export const HabitsPage = () => <StubPage title="Habits" icon={Repeat} />
export const HealthPage = () => <StubPage title="Health" icon={Heart} />
export const WealthPage = () => <StubPage title="Wealth" icon={Wallet} />
export const HomePage = () => <StubPage title="Home" icon={Home} />
export const FamilyPage = () => <StubPage title="Family" icon={Users} />

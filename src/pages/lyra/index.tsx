import { useState } from 'react'
import { StrategicDashboard } from './strategic-dashboard'
import { LyraChat } from './lyra-chat'
import { ToolsPanel } from './tools-panel'

export function LyraPage() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* Top: Strategic dashboard strip */}
      <StrategicDashboard />

      {/* Bottom: Chat + Tools two-column layout */}
      <div className="flex flex-1 min-h-0">
        <LyraChat />
        <ToolsPanel
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
        />
      </div>
    </div>
  )
}

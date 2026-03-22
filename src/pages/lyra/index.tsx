import { useState } from 'react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StrategicDashboard } from './strategic-dashboard'
import { LyraChat } from './lyra-chat'
import { ToolsPanel } from './tools-panel'
import { LyraLog } from './lyra-log'

export function LyraPage() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chatTab, setChatTab] = useState('chat')

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* Top: Strategic dashboard strip */}
      <StrategicDashboard />

      {/* Bottom: Chat/Log + Tools two-column layout */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat / Log tabs */}
          <div className="px-3 pt-2 shrink-0">
            <Tabs value={chatTab} onValueChange={setChatTab}>
              <TabsList className="h-7">
                <TabsTrigger value="chat" className="text-[11px] h-5 px-2">Chat</TabsTrigger>
                <TabsTrigger value="log" className="text-[11px] h-5 px-2">Event Log</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {chatTab === 'chat' ? <LyraChat /> : <LyraLog />}
        </div>
        <ToolsPanel
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
        />
      </div>
    </div>
  )
}

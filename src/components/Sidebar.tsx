import { Tooltip } from 'antd'
import { ApiOutlined, ControlOutlined, EyeOutlined, GlobalOutlined, CodeOutlined } from '@ant-design/icons'
import { ConnectionPanel } from './ConnectionPanel'
import { FrequencyPanel } from './FrequencyPanel'
import { DisplayPanel } from './DisplayPanel'
import { PresetsPanel } from './PresetsPanel'
import { DecodePanelControls } from './DecodePanel'
import { useAppStore } from '../stores/appStore'

const collapsedIcons = [
  { key: 'connection', label: 'CONNECTION', icon: <ApiOutlined /> },
  { key: 'sdr', label: 'SDR CONFIG', icon: <ControlOutlined /> },
  { key: 'display', label: 'DISPLAY', icon: <EyeOutlined /> },
  { key: 'presets', label: 'UHF RFID BANDS', icon: <GlobalOutlined /> },
  { key: 'decode', label: 'PROTOCOL DECODE', icon: <CodeOutlined /> },
]

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, letterSpacing: 1,
      textTransform: 'uppercase', opacity: 0.4,
      padding: '14px 0 6px', marginTop: 2,
    }}>
      {children}
    </div>
  )
}

export function Sidebar() {
  const collapsed = useAppStore(s => s.sidebarCollapsed)
  const toggleSidebar = useAppStore(s => s.toggleSidebar)

  if (collapsed) {
    return (
      <div style={{
        width: 48, flexShrink: 0,
        borderRight: '1px solid var(--border-color)',
        overflowY: 'hidden', overflowX: 'hidden',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          paddingTop: 10, gap: 2,
        }}>
          {collapsedIcons.map(p => (
            <Tooltip key={p.key} title={p.label} placement="right">
              <button
                onClick={toggleSidebar}
                style={{
                  width: 36, height: 36, padding: 0,
                  border: 'none', borderRadius: 6,
                  background: 'transparent', color: 'inherit',
                  cursor: 'pointer', fontSize: 17,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: 0.6,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; (e.currentTarget as HTMLButtonElement).style.background = 'rgba(128,128,128,0.1)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.6'; (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                {p.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      width: 280, flexShrink: 0,
      overflowY: 'auto', overflowX: 'hidden',
      borderRight: '1px solid var(--border-color)',
      padding: '4px 14px 20px',
    }}>
      <SectionHeader>Connection</SectionHeader>
      <ConnectionPanel />

      <SectionHeader>SDR Configuration</SectionHeader>
      <FrequencyPanel />

      <SectionHeader>Display</SectionHeader>
      <DisplayPanel />

      <SectionHeader>UHF RFID Bands</SectionHeader>
      <PresetsPanel />

      <SectionHeader>Sequence</SectionHeader>
      <DecodePanelControls />
    </div>
  )
}

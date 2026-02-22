import { useAppStore } from '../stores/appStore'
import { ThemeToggle } from './ThemeToggle'
import { getFps } from '../services/connection'
import { useEffect, useState } from 'react'
import { MenuFoldOutlined, MenuUnfoldOutlined, PauseCircleFilled, PlayCircleFilled } from '@ant-design/icons'
import { Tooltip } from 'antd'

export function Header() {
  const connected = useAppStore(s => s.connected)
  const paused = useAppStore(s => s.paused)
  const setPaused = useAppStore(s => s.setPaused)
  const statusText = useAppStore(s => s.statusText)
  const sidebarCollapsed = useAppStore(s => s.sidebarCollapsed)
  const toggleSidebar = useAppStore(s => s.toggleSidebar)
  const showSpectrum = useAppStore(s => s.showSpectrum)
  const showTimeline = useAppStore(s => s.showTimeline)
  const showDecodeTable = useAppStore(s => s.showDecodeTable)
  const togglePanel = useAppStore(s => s.togglePanel)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setFps(getFps()), 1000)
    return () => clearInterval(id)
  }, [])

  const statusDotColor = connected ? (paused ? '#ff6b35' : '#00ff88') : '#ff3355'

  const panels: { key: 'showSpectrum' | 'showTimeline' | 'showDecodeTable'; label: string; shortcut: string; active: boolean }[] = [
    { key: 'showSpectrum', label: 'FFT Spectrum', shortcut: '1', active: showSpectrum },
    { key: 'showTimeline', label: 'Command Timeline', shortcut: '2', active: showTimeline },
    { key: 'showDecodeTable', label: 'Decode Table', shortcut: '3', active: showDecodeTable },
  ]

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 16px', borderBottom: '1px solid var(--border-color)',
      flexShrink: 0, gap: 16, height: 48,
    }}>
      {/* Left: toggle + title + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <Tooltip title={sidebarCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}>
          <button onClick={toggleSidebar} style={iconBtnStyle} aria-label="Toggle sidebar">
            {sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </Tooltip>
        <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.5, whiteSpace: 'nowrap', color: 'var(--accent-color)' }}>
          UHF RFID SPECTRUM ANALYZER
        </span>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 12,
          background: 'rgba(128,128,128,0.1)',
          fontSize: 11, whiteSpace: 'nowrap',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: statusDotColor, display: 'inline-block', flexShrink: 0,
          }} />
          <span style={{ opacity: 0.8 }}>{statusText}</span>
        </div>
      </div>

      {/* Center: panel toggles */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {panels.map(p => (
          <button
            key={p.key}
            onClick={() => togglePanel(p.key)}
            title={`Toggle ${p.label} (${p.shortcut})`}
            style={{
              height: 30, padding: '0 14px',
              border: p.active ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
              borderRadius: 6,
              background: p.active ? 'rgba(0, 212, 255, 0.1)' : 'transparent',
              color: p.active ? 'var(--accent-color)' : 'inherit',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
              fontWeight: 500,
              display: 'flex', alignItems: 'center', gap: 6,
              opacity: p.active ? 1 : 0.5,
              transition: 'all 150ms ease',
              whiteSpace: 'nowrap',
            }}
          >
            {p.label}
            <span style={{ opacity: 0.4, fontSize: 10 }}>{p.shortcut}</span>
          </button>
        ))}
      </div>

      {/* Right: FPS + pause + theme */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, opacity: 0.4, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>{fps} FPS</span>
        {connected && (
          <Tooltip title={paused ? 'Resume data collection (Space)' : 'Pause data collection (Space)'}>
            <button onClick={() => setPaused(!paused)} style={{
              ...pauseBtnStyle,
              color: paused ? '#ff6b35' : 'inherit',
              borderColor: paused ? '#ff6b35' : 'var(--border-color)',
              background: paused ? 'rgba(255, 107, 53, 0.1)' : 'transparent',
            }}>
              {paused ? <><PlayCircleFilled style={{ marginRight: 4 }} /> Resume</> : <><PauseCircleFilled style={{ marginRight: 4 }} /> Pause</>}
            </button>
          </Tooltip>
        )}
        <ThemeToggle />
      </div>
    </div>
  )
}

const iconBtnStyle: React.CSSProperties = {
  width: 32, height: 32, padding: 0,
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 16,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const pauseBtnStyle: React.CSSProperties = {
  height: 30, padding: '0 12px',
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 500,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
}

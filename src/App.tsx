import { ConfigProvider } from 'antd'
import { useAppStore } from './stores/appStore'
import { darkTheme, lightTheme, FONT_UI, FONT_MONO } from './theme'
import { Header } from './components/Header'
import { Sidebar } from './components/Sidebar'
import { SpectrumCanvas } from './components/SpectrumCanvas'
import { TimelineCanvas } from './components/TimelineCanvas'
import { DecodeTable } from './components/DecodeTable'
import { useDecodeStore } from './stores/decodeStore'
import { connectMock, getMockDecoder } from './services/connection'
import { useEffect, useCallback } from 'react'

export default function App() {
  const themeMode = useAppStore(s => s.themeMode)
  const uiScale = useAppStore(s => s.uiScale)
  const themeConfig = themeMode === 'dark' ? darkTheme : lightTheme
  const showSpectrum = useAppStore(s => s.showSpectrum)
  const showTimeline = useAppStore(s => s.showTimeline)
  const showDecodeTable = useAppStore(s => s.showDecodeTable)

  // Set CSS custom properties for non-antd styled elements
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--font-ui', FONT_UI)
    root.style.setProperty('--font-mono', FONT_MONO)
    if (themeMode === 'dark') {
      root.style.setProperty('--bg-color', '#0a0e14')
      root.style.setProperty('--border-color', '#1e2a38')
      root.style.setProperty('--text-color', '#c8d0d8')
      root.style.setProperty('--panel-bg', '#111820')
      root.style.setProperty('--accent-color', '#00d4ff')
      document.body.style.background = '#0a0e14'
      document.body.style.color = '#c8d0d8'
    } else {
      root.style.setProperty('--bg-color', '#ffffff')
      root.style.setProperty('--border-color', '#d9d9d9')
      root.style.setProperty('--text-color', '#1a1a1a')
      root.style.setProperty('--panel-bg', '#f8f9fa')
      root.style.setProperty('--accent-color', '#0077b6')
      document.body.style.background = '#ffffff'
      document.body.style.color = '#1a1a1a'
    }
  }, [themeMode])

  // Auto-connect in demo/simulation mode via ?demo query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('demo')) {
      const { setConnectionMode, setConnected } = useAppStore.getState()
      const { push } = useDecodeStore.getState()
      setConnectionMode('mock')
      setConnected(true, 'Simulation')
      connectMock(
        () => useAppStore.getState(),
        (data) => {
          const store = useAppStore.getState()
          if (data.bands && Object.keys(data.bands).length > 0) {
            store.setBands(data.bands)
          }
        },
        (msg) => push(msg),
      )
      // Sync mock decoder with store default mode
      const mock = getMockDecoder()
      if (mock) mock.mode = useDecodeStore.getState().sequenceMode
    }
  }, [])

  // Global keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const store = useAppStore.getState()

    if (e.code === 'Space') {
      e.preventDefault()
      store.setPaused(!store.paused)
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
      e.preventDefault()
      store.toggleSidebar()
    } else if (e.key === '1') {
      store.togglePanel('showSpectrum')
    } else if (e.key === '2') {
      store.togglePanel('showTimeline')
    } else if (e.key === '3') {
      store.togglePanel('showDecodeTable')
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <ConfigProvider theme={themeConfig}>
      <div style={{
        display: 'flex', flexDirection: 'column',
        height: `${100 / uiScale}vh`, width: `${100 / uiScale}vw`,
        fontFamily: FONT_UI,
        background: 'var(--bg-color)', color: 'var(--text-color)',
        overflow: 'hidden',
        transform: `scale(${uiScale})`,
        transformOrigin: 'top left',
      }}>
        <Header />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <Sidebar />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
            {showSpectrum && (
              <div style={{ flex: 3, minHeight: 120, display: 'flex', flexDirection: 'column' }}>
                <SpectrumCanvas />
              </div>
            )}
            {showTimeline && (
              <div style={{ flex: 1.5, minHeight: 100, borderTop: showSpectrum ? '1px solid var(--border-color)' : undefined }}>
                <TimelineCanvas />
              </div>
            )}
            {showDecodeTable && (
              <div style={{ flex: 1.5, minHeight: 100, borderTop: (showSpectrum || showTimeline) ? '1px solid var(--border-color)' : undefined }}>
                <DecodeTable />
              </div>
            )}
          </div>
        </div>
      </div>
    </ConfigProvider>
  )
}

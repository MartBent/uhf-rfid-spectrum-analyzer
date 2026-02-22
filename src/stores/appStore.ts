import { create } from 'zustand'

export type ConnectionMode = 'ws' | 'webusb' | 'mock' | 'disconnected'
export type ViewMode = 'timeline' | 'waterfall'
export type ThemeMode = 'dark' | 'light'

export interface Marker {
  freq: number
  label: string
}

export interface BandInfo {
  start: number
  end: number
  channels: number
  power: string
}

export interface SpectrumData {
  freqs: number[]
  live: number[]
  avg: number[]
  peak: number[]
  center_freq: number
  sample_rate: number
  gain: number
  fft_size: number
  bands?: Record<string, BandInfo>
}

interface AppState {
  // Connection
  connectionMode: ConnectionMode
  connected: boolean
  statusText: string

  // SDR config
  centerFreq: number
  sampleRate: number
  gain: number
  fftSize: number
  wsPort: number

  // Display
  viewMode: ViewMode
  refLevel: number
  dynRange: number
  avgAlpha: number
  showLive: boolean
  showAvg: boolean
  showPeak: boolean
  showFill: boolean
  showBands: boolean

  // Markers
  markers: Marker[]
  markerIdCounter: number
  nextMarkerOnClick: boolean

  // Theme
  themeMode: ThemeMode

  // UI Scale
  uiScale: number

  // Sidebar
  sidebarCollapsed: boolean

  // Global pause
  paused: boolean

  // Panel visibility
  showSpectrum: boolean
  showTimeline: boolean
  showDecodeTable: boolean

  // Bands
  bands: Record<string, BandInfo>

  // Actions
  setConnectionMode: (mode: ConnectionMode) => void
  setConnected: (connected: boolean, statusText?: string) => void
  setCenterFreq: (freq: number) => void
  setSampleRate: (rate: number) => void
  setGain: (gain: number) => void
  setFftSize: (size: number) => void
  setWsPort: (port: number) => void
  setViewMode: (mode: ViewMode) => void
  setRefLevel: (level: number) => void
  setDynRange: (range: number) => void
  setAvgAlpha: (alpha: number) => void
  toggleTrace: (trace: 'showLive' | 'showAvg' | 'showPeak' | 'showFill' | 'showBands') => void
  addMarker: (marker: Marker) => void
  removeMarker: (index: number) => void
  clearMarkers: () => void
  setNextMarkerOnClick: (v: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setUiScale: (scale: number) => void
  toggleSidebar: () => void
  setPaused: (paused: boolean) => void
  togglePanel: (panel: 'showSpectrum' | 'showTimeline' | 'showDecodeTable') => void
  setBands: (bands: Record<string, BandInfo>) => void
}

const savedTheme = (typeof localStorage !== 'undefined' && localStorage.getItem('rfid-theme')) as ThemeMode | null
const savedScale = typeof localStorage !== 'undefined' ? parseFloat(localStorage.getItem('rfid-scale') || '') : NaN
const savedSidebarCollapsed = typeof localStorage !== 'undefined' && localStorage.getItem('rfid-sidebar-collapsed') === 'true'

export const useAppStore = create<AppState>((set) => ({
  connectionMode: 'disconnected',
  connected: false,
  statusText: 'Disconnected',
  centerFreq: 915,
  sampleRate: 2.4,
  gain: 40,
  fftSize: 1024,
  wsPort: 8765,
  viewMode: 'timeline',
  refLevel: 0,
  dynRange: 100,
  avgAlpha: 0.3,
  showLive: true,
  showAvg: false,
  showPeak: false,
  showFill: false,
  showBands: true,
  markers: [],
  markerIdCounter: 0,
  nextMarkerOnClick: false,
  themeMode: savedTheme || 'dark',
  uiScale: isNaN(savedScale) ? 1.0 : savedScale,
  sidebarCollapsed: savedSidebarCollapsed,
  paused: false,
  showSpectrum: true,
  showTimeline: true,
  showDecodeTable: true,
  bands: {},

  setConnectionMode: (mode) => set({ connectionMode: mode }),
  setConnected: (connected, statusText) => set(statusText ? { connected, statusText } : { connected }),
  setCenterFreq: (centerFreq) => set({ centerFreq }),
  setSampleRate: (sampleRate) => set({ sampleRate }),
  setGain: (gain) => set({ gain }),
  setFftSize: (fftSize) => set({ fftSize }),
  setWsPort: (wsPort) => set({ wsPort }),
  setViewMode: (viewMode) => set({ viewMode }),
  setRefLevel: (refLevel) => set({ refLevel }),
  setDynRange: (dynRange) => set({ dynRange }),
  setAvgAlpha: (avgAlpha) => set({ avgAlpha }),
  toggleTrace: (trace) => set((s) => ({ [trace]: !s[trace] })),
  addMarker: (marker) => set((s) => ({
    markers: [...s.markers, marker],
    markerIdCounter: s.markerIdCounter + 1,
  })),
  removeMarker: (index) => set((s) => ({
    markers: s.markers.filter((_, i) => i !== index),
  })),
  clearMarkers: () => set({ markers: [], nextMarkerOnClick: false }),
  setNextMarkerOnClick: (v) => set({ nextMarkerOnClick: v }),
  setThemeMode: (themeMode) => {
    localStorage.setItem('rfid-theme', themeMode)
    set({ themeMode })
  },
  setUiScale: (uiScale) => {
    localStorage.setItem('rfid-scale', String(uiScale))
    set({ uiScale })
  },
  toggleSidebar: () => set((s) => {
    const next = !s.sidebarCollapsed
    localStorage.setItem('rfid-sidebar-collapsed', String(next))
    return { sidebarCollapsed: next }
  }),
  setPaused: (paused) => set({ paused }),
  togglePanel: (panel) => set((s) => ({ [panel]: !s[panel] })),
  setBands: (bands) => set({ bands }),
}))

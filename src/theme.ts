import { theme as antdTheme, ThemeConfig } from 'antd'

export const FONT_UI = "'Outfit', sans-serif"
export const FONT_MONO = "'JetBrains Mono', monospace"

export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: '#00d4ff',
    colorBgBase: '#0a0e14',
    colorBgContainer: '#111820',
    colorBorder: '#1e2a38',
    colorText: '#c8d0d8',
    colorTextSecondary: '#607080',
    fontFamily: FONT_UI,
    borderRadius: 6,
    fontSize: 13,
  },
  components: {
    Button: { borderRadius: 6, controlHeight: 32, fontSize: 12 },
    Input: { controlHeight: 32, fontSize: 12 },
    InputNumber: { controlHeight: 32, fontSize: 12 },
    Select: { controlHeight: 32, fontSize: 12 },
    Slider: { handleSize: 12, railSize: 4 },
    Switch: { fontSize: 12 },
    Collapse: { headerBg: '#111820', contentBg: '#111820', fontSize: 12 },
    Table: { headerBg: '#0a0e14', rowHoverBg: 'rgba(0, 212, 255, 0.04)', fontSize: 12, cellPaddingInlineSM: 8, cellPaddingBlockSM: 3 },
  },
}

export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#0077b6',
    colorBgBase: '#ffffff',
    colorBgContainer: '#f8f9fa',
    colorBorder: '#d9d9d9',
    colorText: '#1a1a1a',
    colorTextSecondary: '#666666',
    fontFamily: FONT_UI,
    borderRadius: 6,
    fontSize: 13,
  },
  components: {
    Button: { borderRadius: 6, controlHeight: 32, fontSize: 12 },
    Input: { controlHeight: 32, fontSize: 12 },
    InputNumber: { controlHeight: 32, fontSize: 12 },
    Select: { controlHeight: 32, fontSize: 12 },
    Slider: { handleSize: 12, railSize: 4 },
    Switch: { fontSize: 12 },
    Collapse: { headerBg: '#f8f9fa', contentBg: '#f8f9fa', fontSize: 12 },
    Table: { headerBg: '#fafafa', rowHoverBg: 'rgba(0, 119, 182, 0.04)', fontSize: 12, cellPaddingInlineSM: 8, cellPaddingBlockSM: 3 },
  },
}

export interface CanvasColors {
  bg: string
  plotBg: string
  grid: string
  gridText: string
  live: string
  avg: string
  peak: string
  fill: string
  cursor: string
  marker: string
  accent: string
  accent2: string
  green: string
  red: string
  yellow: string
  textDim: string
  border: string
  panel: string
  bandColors: string[]
  bandBorderColors: string[]
}

export const darkCanvasColors: CanvasColors = {
  bg: '#0a0e14',
  plotBg: '#0d1117',
  grid: 'rgba(40, 60, 80, 0.35)',
  gridText: '#506070',
  live: '#00d4ff',
  avg: '#00ff88',
  peak: '#ff6b35',
  fill: 'rgba(0, 212, 255, 0.08)',
  cursor: 'rgba(255,255,255,0.25)',
  marker: '#ffcc00',
  accent: '#00d4ff',
  accent2: '#ff6b35',
  green: '#00ff88',
  red: '#ff3355',
  yellow: '#ffcc00',
  textDim: '#607080',
  border: '#1e2a38',
  panel: '#111820',
  bandColors: [
    'rgba(0, 212, 255, 0.08)',
    'rgba(0, 255, 136, 0.08)',
    'rgba(255, 107, 53, 0.08)',
    'rgba(255, 204, 0, 0.08)',
    'rgba(200, 100, 255, 0.08)',
    'rgba(255, 51, 85, 0.08)',
    'rgba(100, 200, 200, 0.08)',
  ],
  bandBorderColors: [
    'rgba(0, 212, 255, 0.4)',
    'rgba(0, 255, 136, 0.4)',
    'rgba(255, 107, 53, 0.4)',
    'rgba(255, 204, 0, 0.4)',
    'rgba(200, 100, 255, 0.4)',
    'rgba(255, 51, 85, 0.4)',
    'rgba(100, 200, 200, 0.4)',
  ],
}

export const lightCanvasColors: CanvasColors = {
  bg: '#ffffff',
  plotBg: '#f5f5f5',
  grid: 'rgba(0, 0, 0, 0.08)',
  gridText: '#888888',
  live: '#0077b6',
  avg: '#00875a',
  peak: '#d35400',
  fill: 'rgba(0, 119, 182, 0.08)',
  cursor: 'rgba(0,0,0,0.2)',
  marker: '#b8860b',
  accent: '#0077b6',
  accent2: '#d35400',
  green: '#00875a',
  red: '#cc0022',
  yellow: '#b8860b',
  textDim: '#888888',
  border: '#d9d9d9',
  panel: '#f8f9fa',
  bandColors: [
    'rgba(0, 119, 182, 0.06)',
    'rgba(0, 135, 90, 0.06)',
    'rgba(211, 84, 0, 0.06)',
    'rgba(184, 134, 11, 0.06)',
    'rgba(142, 68, 173, 0.06)',
    'rgba(204, 0, 34, 0.06)',
    'rgba(0, 128, 128, 0.06)',
  ],
  bandBorderColors: [
    'rgba(0, 119, 182, 0.3)',
    'rgba(0, 135, 90, 0.3)',
    'rgba(211, 84, 0, 0.3)',
    'rgba(184, 134, 11, 0.3)',
    'rgba(142, 68, 173, 0.3)',
    'rgba(204, 0, 34, 0.3)',
    'rgba(0, 128, 128, 0.3)',
  ],
}

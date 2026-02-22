/**
 * Connection Manager
 * Handles WebSocket, WebUSB, and simulated SDR connections.
 */

import type { SpectrumData } from '../stores/appStore'
import { useAppStore } from '../stores/appStore'
import type { DecodeMessage } from '../stores/decodeStore'
import { WebUSBSpectrumAnalyzer } from './webusb-rtlsdr'
import { MockSpectrumGenerator } from './mockSpectrum'
import { MockRFIDDecoder } from './mockDecode'

// Module-level mutable hot-path data — never stored in React state
export let latestData: SpectrumData | null = null
export const rssiHistory: { time: number; peak: number }[] = []
export let waterfallData: number[][] = []

const RSSI_HISTORY_RETENTION = 120000 // keep 2 min of RSSI for timeline panning
const WATERFALL_ROWS = 256

/** Shared visible time range — updated each frame by TimelineCanvas */
export const visibleTimeRange = { tMin: 0, tMax: 0 }

export function updateHotData(data: SpectrumData) {
  if (useAppStore.getState().paused) return
  latestData = data

  // Waterfall
  waterfallData.push(data.live.slice())
  if (waterfallData.length > WATERFALL_ROWS) waterfallData.shift()

  // RSSI
  let peak = -120
  for (let i = 0; i < data.live.length; i++) {
    if (data.live[i] > peak) peak = data.live[i]
  }
  const now = performance.now()
  rssiHistory.push({ time: now, peak })
  const cutoff = now - RSSI_HISTORY_RETENTION
  while (rssiHistory.length > 0 && rssiHistory[0].time < cutoff) rssiHistory.shift()
}

export function clearHotData() {
  latestData = null
  rssiHistory.length = 0
  waterfallData = []
}

// FPS counter
let frameCount = 0
let lastFpsTime = performance.now()
let currentFps = 0

export function countFrame() { frameCount++ }
export function getFps() {
  const now = performance.now()
  if (now - lastFpsTime >= 1000) {
    currentFps = frameCount
    frameCount = 0
    lastFpsTime = now
  }
  return currentFps
}

// ---- WebSocket connection ----

let ws: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null

export function connectWS(
  port: number,
  onConnect: () => void,
  onDisconnect: () => void,
  onData: (data: SpectrumData) => void,
) {
  disconnectWS()
  const url = `ws://${location.hostname || 'localhost'}:${port}`
  ws = new WebSocket(url)
  ws.onopen = () => onConnect()
  ws.onclose = () => {
    onDisconnect()
    wsReconnectTimer = setTimeout(() => connectWS(port, onConnect, onDisconnect, onData), 2000)
  }
  ws.onerror = () => { try { ws?.close() } catch {} }
  ws.onmessage = (evt) => {
    if (useAppStore.getState().paused) return
    const data = JSON.parse(evt.data) as SpectrumData & { type: string }
    if (data.type === 'spectrum') {
      onData(data)
      updateHotData(data)
      countFrame()
    }
  }
}

export function disconnectWS() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
}

export function sendWS(obj: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj))
  }
}

// ---- WebUSB connection ----

let usbAnalyzer: WebUSBSpectrumAnalyzer | null = null

export function getUSBAnalyzer() { return usbAnalyzer }

export async function connectUSB(
  config: { centerFreq: number; sampleRate: number; gain: number; fftSize: number },
  onConnect: (tunerType: string) => void,
  onData: (data: SpectrumData) => void,
  onError: (err: Error) => void,
  decodeEnabled: boolean,
  onDecodeMessage?: (msg: DecodeMessage) => void,
) {
  try {
    usbAnalyzer = new WebUSBSpectrumAnalyzer()
    usbAnalyzer.fftSize = config.fftSize
    usbAnalyzer.sdr.centerFreq = config.centerFreq * 1e6
    usbAnalyzer.sdr.sampleRate = config.sampleRate * 1e6
    usbAnalyzer.sdr.gain = config.gain

    await usbAnalyzer.open()
    onConnect(usbAnalyzer.sdr.tunerType || 'RTL-SDR')

    usbAnalyzer.onSpectrum = (data) => {
      if (useAppStore.getState().paused) return
      onData(data)
      updateHotData(data)
      countFrame()
    }

    // Wire PIE decoder for real-time decode
    if (decodeEnabled && onDecodeMessage) {
      try {
        const { PIEDecoder } = await import('./pie-decoder')
        const pieDecoder = new PIEDecoder({
          sampleRate: usbAnalyzer.sdr.sampleRate,
          centerFreqMHz: usbAnalyzer.sdr.centerFreq / 1e6,
          onMessage: (msg) => onDecodeMessage(msg as DecodeMessage),
        })
        usbAnalyzer.decodeEnabled = true
        usbAnalyzer.onRawIQ = (iq) => pieDecoder.process(iq)
        usbAnalyzer._pieDecoder = pieDecoder
      } catch (e) {
        console.warn('[Connection] PIE decoder not available:', e)
      }
    }

    usbAnalyzer.start(20)
  } catch (e) {
    onError(e as Error)
  }
}

export async function disconnectUSB() {
  if (usbAnalyzer) {
    await usbAnalyzer.close()
    usbAnalyzer = null
  }
}

export function sendUSB(obj: Record<string, unknown>) {
  if (!usbAnalyzer) return
  const action = obj.action as string
  if (action === 'set_center_freq') {
    usbAnalyzer.setCenterFreq(parseFloat(obj.value as string))
    if (usbAnalyzer._pieDecoder) usbAnalyzer._pieDecoder.setCenterFreq(parseFloat(obj.value as string))
  } else if (action === 'set_sample_rate') {
    usbAnalyzer.setSampleRate(parseFloat(obj.value as string))
    if (usbAnalyzer._pieDecoder) usbAnalyzer._pieDecoder.reset()
  } else if (action === 'set_gain') usbAnalyzer.setGain(parseFloat(obj.value as string))
  else if (action === 'set_fft_size') usbAnalyzer.setFFTSize(parseInt(obj.value as string))
  else if (action === 'set_avg_alpha') usbAnalyzer.avgAlpha = parseFloat(obj.value as string)
  else if (action === 'reset_peak') usbAnalyzer.resetPeakHold()
}

// ---- Mock/Simulated connection ----

let mockGenerator: MockSpectrumGenerator | null = null
let mockDecoder: MockRFIDDecoder | null = null
let mockInterval: ReturnType<typeof setInterval> | null = null

export function connectMock(
  getConfig: () => { centerFreq: number; sampleRate: number; gain: number; fftSize: number; avgAlpha: number },
  onData: (data: SpectrumData) => void,
  onDecodeMessage: (msg: DecodeMessage) => void,
  fps = 20,
) {
  disconnectMock()
  mockGenerator = new MockSpectrumGenerator()
  let msgId = 0
  mockDecoder = new MockRFIDDecoder((msg) => {
    const fullMsg = { ...msg, id: ++msgId, timestamp: performance.now() } as DecodeMessage
    onDecodeMessage(fullMsg)
  })

  mockInterval = setInterval(() => {
    if (useAppStore.getState().paused) return
    const cfg = getConfig()
    const data = mockGenerator!.generateFrame(cfg.centerFreq, cfg.sampleRate, cfg.gain, cfg.fftSize, cfg.avgAlpha)
    onData(data)
    updateHotData(data)
    countFrame()
    mockDecoder!.tick()
  }, 1000 / fps)
}

export function disconnectMock() {
  if (mockInterval) { clearInterval(mockInterval); mockInterval = null }
  mockGenerator = null
  mockDecoder = null
}

export function getMockDecoder() { return mockDecoder }

export function sendMock(obj: Record<string, unknown>) {
  if (obj.action === 'reset_peak' && mockGenerator) {
    mockGenerator.resetPeak()
  }
}

// ---- Unified send ----

export function send(connectionMode: string, obj: Record<string, unknown>) {
  if (connectionMode === 'ws') sendWS(obj)
  else if (connectionMode === 'webusb') sendUSB(obj)
  else if (connectionMode === 'mock') sendMock(obj)
}

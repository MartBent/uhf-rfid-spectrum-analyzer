import { useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { latestData } from '../services/connection'
import { drawSpectrum } from '../canvas/spectrum'
import { darkCanvasColors, lightCanvasColors } from '../theme'
import { send } from '../services/connection'

const SPAN_STEPS = [0.5, 1.0, 1.4, 2.0, 2.4]

export function SpectrumCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cursorXRef = useRef(-1)
  const cursorInfoRef = useRef<HTMLDivElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)

  const themeMode = useAppStore(s => s.themeMode)
  const sampleRate = useAppStore(s => s.sampleRate)
  const connectionMode = useAppStore(s => s.connectionMode)
  const setSampleRate = useAppStore(s => s.setSampleRate)

  const handleResize = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const dpr = window.devicePixelRatio
    canvas.width = container.clientWidth * dpr
    canvas.height = container.clientHeight * dpr
  }, [])

  useEffect(() => {
    handleResize()
    const obs = new ResizeObserver(handleResize)
    if (containerRef.current) obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [handleResize])

  // Animation loop
  useEffect(() => {
    let rafId: number
    const colors = themeMode === 'dark' ? darkCanvasColors : lightCanvasColors

    const loop = () => {
      rafId = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      if (!canvas || !latestData) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const state = useAppStore.getState()
      const result = drawSpectrum(ctx, canvas.width, canvas.height, {
        data: latestData,
        showLive: state.showLive,
        showAvg: state.showAvg,
        showPeak: state.showPeak,
        showFill: state.showFill,
        showBands: state.showBands,
        refLevel: state.refLevel,
        dynRange: state.dynRange,
        markers: state.markers,
        cursorX: cursorXRef.current,
        colors,
      })

      // Update cursor readout
      if (cursorInfoRef.current) {
        if (result) {
          cursorInfoRef.current.textContent = `${result.cursorFreq.toFixed(3)} MHz | ${result.cursorDb.toFixed(1)} dB`
        } else {
          cursorInfoRef.current.textContent = ''
        }
      }

      // Update info overlay
      if (infoRef.current) {
        infoRef.current.innerHTML = [
          `FC: ${latestData.center_freq.toFixed(3)} MHz`,
          `Span: ${latestData.sample_rate.toFixed(1)} MHz`,
          `Gain: ${latestData.gain} dB`,
          `FFT: ${latestData.fft_size}`,
          `Ref: ${state.refLevel} dB`,
        ].join('<br>')
      }
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [themeMode])

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect) cursorXRef.current = (e.clientX - rect.left) / rect.width
  }

  const legendColors = themeMode === 'dark' ? darkCanvasColors : lightCanvasColors

  const zoomIn = () => {
    const idx = SPAN_STEPS.indexOf(sampleRate)
    if (idx > 0) {
      const next = SPAN_STEPS[idx - 1]
      setSampleRate(next)
      send(connectionMode, { action: 'set_sample_rate', value: next })
    }
  }

  const zoomOut = () => {
    const idx = SPAN_STEPS.indexOf(sampleRate)
    if (idx < SPAN_STEPS.length - 1) {
      const next = SPAN_STEPS[idx + 1]
      setSampleRate(next)
      send(connectionMode, { action: 'set_sample_rate', value: next })
    }
  }

  return (
    <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      <canvas ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { cursorXRef.current = -1 }}
      />
      <div style={{ position: 'absolute', top: 10, left: 14, display: 'flex', gap: 16, fontSize: 11, pointerEvents: 'none' }}>
        <LegendItem color={legendColors.live} label="Live" />
        <LegendItem color={legendColors.avg} label="Average" />
        <LegendItem color={legendColors.peak} label="Peak Hold" />
      </div>
      <div ref={infoRef} style={{
        position: 'absolute', top: 10, right: 14, fontSize: 12,
        fontFamily: 'var(--font-mono)',
        opacity: 0.5, textAlign: 'right', pointerEvents: 'none', lineHeight: 1.6,
      }} />
      <div ref={cursorInfoRef} style={{
        position: 'absolute', bottom: 10, left: 14, fontSize: 12,
        fontFamily: 'var(--font-mono)',
        color: '#ffcc00', pointerEvents: 'none',
      }} />
      <ZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} />
    </div>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 18, height: 3, borderRadius: 1.5, background: color, display: 'inline-block' }} />
      <span>{label}</span>
    </div>
  )
}

function ZoomControls({ onZoomIn, onZoomOut }: { onZoomIn: () => void; onZoomOut: () => void }) {
  return (
    <div style={{
      position: 'absolute', bottom: 10, right: 14,
      display: 'flex', gap: 3, zIndex: 5,
    }}>
      <button onClick={onZoomOut} style={zoomBtnStyle} title="Zoom out">-</button>
      <button onClick={onZoomIn} style={zoomBtnStyle} title="Zoom in">+</button>
    </div>
  )
}

const zoomBtnStyle: React.CSSProperties = {
  width: 28, height: 28, padding: 0,
  border: '1px solid var(--border-color)',
  borderRadius: 6,
  background: 'rgba(0,0,0,0.4)',
  color: 'var(--text-color)',
  cursor: 'pointer',
  fontSize: 16,
  fontWeight: 500,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit',
  backdropFilter: 'blur(4px)',
  opacity: 0.7,
  transition: 'opacity 150ms',
}

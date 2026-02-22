import { useRef, useEffect, useCallback, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useDecodeStore } from '../stores/decodeStore'
import type { DecodeMessage } from '../stores/decodeStore'
import { latestData, rssiHistory, waterfallData, visibleTimeRange } from '../services/connection'
import { drawWaterfall } from '../canvas/waterfall'
import { drawRssiTimeline, type MarkerHitBox, DEFAULT_TIME_WINDOW, MIN_TIME_WINDOW, MAX_TIME_WINDOW } from '../canvas/rssiTimeline'
import { darkCanvasColors, lightCanvasColors } from '../theme'
import { cmdColor, fmtDetail, getCmdClass } from '../canvas/colors'

const HIT_RADIUS = 12

const TIME_STEPS = [2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000, 45000, 60000]

export function TimelineCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hitBoxesRef = useRef<MarkerHitBox[]>([])
  const timeWindowRef = useRef(DEFAULT_TIME_WINDOW)
  const pausedAnchorRef = useRef(0)
  const wasPausedRef = useRef(false)

  const [tooltip, setTooltip] = useState<{
    msg: DecodeMessage
    x: number
    y: number
  } | null>(null)
  const [, forceUpdate] = useState(0)

  const themeMode = useAppStore(s => s.themeMode)
  const viewMode = useAppStore(s => s.viewMode)

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

  useEffect(() => {
    let rafId: number
    const colors = themeMode === 'dark' ? darkCanvasColors : lightCanvasColors

    const loop = () => {
      rafId = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const state = useAppStore.getState()

      // Track pause transitions
      if (state.paused && !wasPausedRef.current) {
        pausedAnchorRef.current = performance.now()
        wasPausedRef.current = true
      } else if (!state.paused && wasPausedRef.current) {
        wasPausedRef.current = false
      }

      if (viewMode === 'waterfall') {
        if (!latestData) return
        hitBoxesRef.current = []
        drawWaterfall(
          ctx, canvas.width, canvas.height,
          waterfallData,
          latestData.freqs[0],
          latestData.freqs[latestData.freqs.length - 1],
          state.refLevel,
          state.dynRange,
          colors,
        )
      } else {
        const decodeLog = useDecodeStore.getState().log
        const anchorTime = state.paused ? pausedAnchorRef.current : performance.now()

        const result = drawRssiTimeline(
          ctx, canvas.width, canvas.height,
          rssiHistory,
          decodeLog,
          state.refLevel,
          state.dynRange,
          colors,
          timeWindowRef.current,
          anchorTime,
          state.paused,
          true,
        )
        hitBoxesRef.current = result.hitBoxes

        // Update shared visible time range for DecodeTable sync
        visibleTimeRange.tMin = result.tMin
        visibleTimeRange.tMax = result.tMax
      }
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, [themeMode, viewMode])

  const toLocal = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width * container.clientWidth,
      y: (e.clientY - rect.top) / rect.height * container.clientHeight,
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const local = toLocal(e)
    if (!local) return

    let best: MarkerHitBox | null = null
    let bestDist = HIT_RADIUS
    for (const hb of hitBoxesRef.current) {
      const dx = hb.cx - local.x
      const dy = hb.cy - local.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < bestDist) {
        bestDist = d
        best = hb
      }
    }

    if (best) {
      setTooltip({ msg: best.msg, x: best.cx, y: best.cy })
    } else {
      setTooltip(null)
    }
  }, [toLocal])

  const handleMouseLeave = useCallback(() => {
    setTooltip(null)
  }, [])

  const zoomIn = () => {
    const cur = timeWindowRef.current
    for (let i = TIME_STEPS.length - 1; i >= 0; i--) {
      if (TIME_STEPS[i] < cur) {
        timeWindowRef.current = TIME_STEPS[i]
        forceUpdate(n => n + 1)
        return
      }
    }
    timeWindowRef.current = MIN_TIME_WINDOW
    forceUpdate(n => n + 1)
  }

  const zoomOut = () => {
    const cur = timeWindowRef.current
    for (let i = 0; i < TIME_STEPS.length; i++) {
      if (TIME_STEPS[i] > cur) {
        timeWindowRef.current = TIME_STEPS[i]
        forceUpdate(n => n + 1)
        return
      }
    }
    timeWindowRef.current = MAX_TIME_WINDOW
    forceUpdate(n => n + 1)
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <canvas ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && <MarkerTooltip msg={tooltip.msg} x={tooltip.x} y={tooltip.y} themeMode={themeMode} />}
      <ZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} />
    </div>
  )
}

function MarkerTooltip({ msg, x, y, themeMode }: {
  msg: DecodeMessage
  x: number
  y: number
  themeMode: 'dark' | 'light'
}) {
  const color = cmdColor(msg.command)
  const category = getCmdClass(msg.command)
  const detail = fmtDetail(msg)
  const isDark = themeMode === 'dark'

  return (
    <div style={{
      position: 'absolute',
      left: x,
      top: y - 8,
      transform: 'translate(-50%, -100%)',
      pointerEvents: 'none',
      zIndex: 10,
      background: isDark ? 'rgba(10, 14, 20, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      border: `1px solid ${isDark ? '#2a3a4a' : '#d0d0d0'}`,
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      maxWidth: 340,
      whiteSpace: 'nowrap',
      boxShadow: isDark
        ? '0 4px 12px rgba(0,0,0,0.5)'
        : '0 4px 12px rgba(0,0,0,0.15)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ color, fontWeight: 700, fontSize: 12 }}>
          {msg.command}
        </span>
        <span style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase' }}>
          {category}
        </span>
        <span style={{ color: msg.direction === 'R2T' ? '#ff6b35' : '#00ff88', fontSize: 10 }}>
          {msg.direction === 'R2T' ? 'Reader \u2192 Tag' : 'Tag \u2192 Reader'}
        </span>
      </div>
      {detail && (
        <div style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {detail}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 4, opacity: 0.5, fontSize: 10 }}>
        <span>Round {msg.roundId}</span>
        <span>{msg.freq.toFixed(1)} MHz</span>
        {msg.tagEpc && <span style={{ color: isDark ? '#00d4ff' : '#0077b6' }}>EPC: {msg.tagEpc}</span>}
      </div>
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

import type { CanvasColors } from '../theme'
import type { DecodeMessage } from '../stores/decodeStore'
import { cmdColor } from './colors'

export const DEFAULT_TIME_WINDOW = 10000
export const MIN_TIME_WINDOW = 2000
export const MAX_TIME_WINDOW = 60000

export interface MarkerHitBox {
  msg: DecodeMessage
  /** center x in CSS pixels */
  cx: number
  /** center y in CSS pixels */
  cy: number
}

export interface TimelineDrawResult {
  hitBoxes: MarkerHitBox[]
  tMin: number
  tMax: number
  padLeft: number
  plotW: number
}

// Rounded rectangle helper
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

export function drawRssiTimeline(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  _rssiHistory: { time: number; peak: number }[],
  decodeLog: DecodeMessage[],
  _refLevel: number,
  _range: number,
  colors: CanvasColors,
  timeWindow: number = DEFAULT_TIME_WINDOW,
  anchorTime: number = performance.now(),
  paused: boolean = false,
  _isLive: boolean = true,
): TimelineDrawResult {
  const dpr = window.devicePixelRatio
  ctx.clearRect(0, 0, W, H)

  // Layout
  const pad = { top: 6 * dpr, bottom: 22 * dpr, left: 12 * dpr, right: 8 * dpr }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const centerY = pad.top + plotH / 2

  const tMax = anchorTime
  const tMin = anchorTime - timeWindow
  const tx = (t: number) => pad.left + plotW * ((t - tMin) / (tMax - tMin))

  // ── Background ──

  ctx.fillStyle = colors.plotBg
  ctx.fillRect(pad.left, pad.top, plotW, plotH)

  // ── Round backgrounds (alternating subtle stripes) ──

  if (decodeLog.length > 0) {
    let prevRound = -1
    let roundStartX = pad.left
    let roundIdx = 0
    for (const msg of decodeLog) {
      if (!msg.timestamp || msg.timestamp < tMin || msg.timestamp > tMax) continue
      if (prevRound !== -1 && msg.roundId !== prevRound) {
        const mx = tx(msg.timestamp)
        if (roundIdx % 2 === 1) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
          ctx.fillRect(roundStartX, pad.top, mx - roundStartX, plotH)
        }
        roundStartX = mx
        roundIdx++
      }
      prevRound = msg.roundId
    }
    if (roundIdx % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
      ctx.fillRect(roundStartX, pad.top, pad.left + plotW - roundStartX, plotH)
    }
  }

  // ── Grid lines (time) ──

  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  for (let s = 1; s <= 9; s++) {
    const t = tMin + s * (timeWindow / 10)
    const x = tx(t)
    ctx.beginPath()
    ctx.moveTo(x, pad.top)
    ctx.lineTo(x, pad.top + plotH)
    ctx.stroke()
  }

  // Time axis labels
  ctx.fillStyle = colors.gridText
  ctx.font = `${11 * dpr}px 'JetBrains Mono', monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const useDecimal = timeWindow <= 5000
  for (let s = 0; s <= 10; s += 2) {
    const t = tMin + s * (timeWindow / 10)
    const x = tx(t)
    const secsAgo = (tMax - t) / 1000
    const label = secsAgo < 0.05 ? 'now' : `-${useDecimal ? secsAgo.toFixed(1) : secsAgo.toFixed(0)}s`
    ctx.fillText(label, x, pad.top + plotH + 2 * dpr)
  }

  // ── Time window indicator ──

  const winSecs = timeWindow / 1000
  const winLabel = winSecs >= 10 ? `${winSecs.toFixed(0)}s` : `${winSecs.toFixed(1)}s`
  ctx.fillStyle = colors.gridText
  ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillText(`\u231a ${winLabel}`, pad.left + plotW - 4 * dpr, pad.top + 3 * dpr)

  // ── Paused indicator ──

  if (paused) {
    ctx.fillStyle = '#ff6b35'
    ctx.font = `bold ${12 * dpr}px 'JetBrains Mono', monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('\u23f8 PAUSED', pad.left + 6 * dpr, pad.top + 3 * dpr)
  }

  // ── Draw messages as independent events on a single timeline ──

  const hitBoxes: MarkerHitBox[] = []
  const pillH = Math.min(40 * dpr, plotH * 0.6)
  const pillFont = Math.min(14 * dpr, pillH * 0.4)
  const minPillW = 20 * dpr
  const labelGap = 4 * dpr
  const dirIndicatorH = 4 * dpr

  // Single collision track — all messages share the same lane
  let lastLabelEnd = -Infinity

  for (const msg of decodeLog) {
    if (!msg.timestamp || msg.timestamp < tMin || msg.timestamp > tMax) continue

    const mx = tx(msg.timestamp)
    const isR2T = msg.direction === 'R2T'
    const color = cmdColor(msg.command)
    const dirColor = isR2T ? '#ff6b35' : '#00ff88'

    // ── Draw command pill or tick ──

    const canLabel = (mx - lastLabelEnd) > labelGap

    if (canLabel) {
      // Measure text
      ctx.font = `bold ${pillFont}px 'JetBrains Mono', monospace`
      const textW = ctx.measureText(msg.command).width
      const pw = Math.max(minPillW, textW + 16 * dpr)

      // Pill background
      const rx = mx - pw / 2
      const ry = centerY - pillH / 2

      ctx.fillStyle = `${color}18`
      ctx.strokeStyle = `${color}80`
      ctx.lineWidth = 1 * dpr
      roundRect(ctx, rx, ry, pw, pillH, 6 * dpr)
      ctx.fill()
      ctx.stroke()

      // Direction indicator — thin colored bar at bottom of pill
      ctx.fillStyle = dirColor
      const barY = centerY + pillH / 2 - dirIndicatorH
      ctx.fillRect(rx + 1, barY, pw - 2, dirIndicatorH)

      // Command text
      ctx.fillStyle = color
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(msg.command, mx, centerY - 1 * dpr)

      lastLabelEnd = mx + pw / 2
    } else {
      // Dense mode: colored tick
      const tickW = 3 * dpr
      const tickH = pillH * 0.8
      ctx.fillStyle = `${color}90`
      ctx.fillRect(mx - tickW / 2, centerY - tickH / 2, tickW, tickH)

      // Direction dot below tick
      ctx.fillStyle = dirColor
      ctx.beginPath()
      ctx.arc(mx, centerY + tickH / 2 + 3 * dpr, 2.5 * dpr, 0, Math.PI * 2)
      ctx.fill()
    }

    // Hit box for tooltip
    hitBoxes.push({ msg, cx: mx / dpr, cy: centerY / dpr })
  }

  // ── "Now" indicator ──

  if (!paused) {
    const nowX = pad.left + plotW
    ctx.strokeStyle = `${colors.accent}40`
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.moveTo(nowX, pad.top)
    ctx.lineTo(nowX, pad.top + plotH)
    ctx.stroke()
  }

  return { hitBoxes, tMin, tMax, padLeft: pad.left, plotW }
}

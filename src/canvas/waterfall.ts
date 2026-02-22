import type { CanvasColors } from '../theme'
import { waterfallColor } from './colors'

const WATERFALL_ROWS = 256

export function drawWaterfall(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  waterfallData: number[][],
  fMin: number,
  fMax: number,
  refLevel: number,
  range: number,
  colors: CanvasColors,
) {
  const dpr = window.devicePixelRatio
  ctx.clearRect(0, 0, W, H)

  if (waterfallData.length > 0) {
    const rowH = H / WATERFALL_ROWS
    for (let r = 0; r < waterfallData.length; r++) {
      const row = waterfallData[waterfallData.length - 1 - r]
      const binW = W / row.length
      for (let i = 0; i < row.length; i++) {
        ctx.fillStyle = waterfallColor(row[i], refLevel, range, colors)
        ctx.fillRect(i * binW, r * rowH, Math.ceil(binW), Math.ceil(rowH))
      }
    }
  }

  // Frequency axis labels
  const fSpan = fMax - fMin
  const fStep = fSpan <= 1 ? 0.1 : fSpan <= 3 ? 0.5 : 1.0
  const fStart = Math.ceil(fMin / fStep) * fStep
  ctx.fillStyle = colors.gridText
  ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (let f = fStart; f <= fMax; f += fStep) {
    const x = W * ((f - fMin) / fSpan)
    ctx.fillText(`${f.toFixed(1)}`, x, 2 * dpr)
  }
}

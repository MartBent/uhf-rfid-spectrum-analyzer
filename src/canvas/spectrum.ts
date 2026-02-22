import type { CanvasColors } from '../theme'
import type { SpectrumData, Marker, BandInfo } from '../stores/appStore'

interface SpectrumOptions {
  data: SpectrumData
  showLive: boolean
  showAvg: boolean
  showPeak: boolean
  showFill: boolean
  showBands: boolean
  refLevel: number
  dynRange: number
  markers: Marker[]
  cursorX: number
  colors: CanvasColors
}

export function drawSpectrum(ctx: CanvasRenderingContext2D, W: number, H: number, opts: SpectrumOptions) {
  const { data: d, refLevel, dynRange: range, colors } = opts
  const dpr = window.devicePixelRatio
  const freqs = d.freqs
  const fMin = freqs[0]
  const fMax = freqs[freqs.length - 1]
  const n = freqs.length
  const minDb = refLevel - range

  const pad = { top: 30 * dpr, bottom: 30 * dpr, left: 50 * dpr, right: 16 * dpr }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  ctx.clearRect(0, 0, W, H)

  // Background
  ctx.fillStyle = colors.plotBg
  ctx.fillRect(pad.left, pad.top, plotW, plotH)

  // Grid - horizontal (dB)
  ctx.strokeStyle = colors.grid
  ctx.lineWidth = 1
  ctx.fillStyle = colors.gridText
  ctx.font = `${11 * dpr}px 'JetBrains Mono', monospace`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  const dbStep = range <= 60 ? 10 : 20
  for (let db = minDb; db <= refLevel; db += dbStep) {
    const y = pad.top + plotH * (1 - (db - minDb) / range)
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke()
    ctx.fillText(`${db}`, pad.left - 6 * dpr, y)
  }

  // Grid - vertical (freq)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const fSpan = fMax - fMin
  const fStep = fSpan <= 1 ? 0.1 : fSpan <= 3 ? 0.5 : 1.0
  const fStart = Math.ceil(fMin / fStep) * fStep
  for (let f = fStart; f <= fMax; f += fStep) {
    const x = pad.left + plotW * ((f - fMin) / fSpan)
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke()
    ctx.fillText(`${f.toFixed(1)}`, x, pad.top + plotH + 4 * dpr)
  }

  // Band overlays
  if (opts.showBands && d.bands) {
    let bi = 0
    Object.entries(d.bands).forEach(([name, b]) => {
      const x0 = pad.left + plotW * Math.max(0, (b.start - fMin) / fSpan)
      const x1 = pad.left + plotW * Math.min(1, (b.end - fMin) / fSpan)
      if (x1 > pad.left && x0 < pad.left + plotW) {
        ctx.fillStyle = colors.bandColors[bi % colors.bandColors.length]
        ctx.fillRect(x0, pad.top, x1 - x0, plotH)
        ctx.strokeStyle = colors.bandBorderColors[bi % colors.bandBorderColors.length]
        ctx.lineWidth = 1 * dpr
        ctx.strokeRect(x0, pad.top, x1 - x0, plotH)
        ctx.fillStyle = colors.bandBorderColors[bi % colors.bandBorderColors.length]
        ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(name, (x0 + x1) / 2, pad.top - 2 * dpr)
      }
      bi++
    })
  }

  const dy = (db: number) => pad.top + plotH * (1 - (Math.max(minDb, Math.min(refLevel, db)) - minDb) / range)
  const fx = (f: number) => pad.left + plotW * ((f - fMin) / fSpan)

  function drawTrace(arr: number[], color: string, lineWidth: number, fill: string | false) {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = pad.left + (i / (n - 1)) * plotW
      const y = dy(arr[i])
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    if (fill) {
      ctx.lineTo(pad.left + plotW, pad.top + plotH)
      ctx.lineTo(pad.left, pad.top + plotH)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth * dpr
    ctx.stroke()
  }

  if (opts.showPeak) drawTrace(d.peak, colors.peak, 1, false)
  if (opts.showAvg) drawTrace(d.avg, colors.avg, 1.2, false)
  if (opts.showLive) {
    const fillColor = opts.showFill ? colors.fill : false
    drawTrace(d.live, colors.live, 1.5, fillColor)
  }

  // Markers
  opts.markers.forEach(m => {
    const x = fx(m.freq)
    if (x < pad.left || x > pad.left + plotW) return
    const binIdx = Math.round((m.freq - fMin) / fSpan * (n - 1))
    const db = (binIdx >= 0 && binIdx < n) ? d.live[binIdx] : minDb
    const y = dy(db)
    ctx.strokeStyle = colors.marker
    ctx.lineWidth = 1 * dpr
    ctx.setLineDash([4 * dpr, 3 * dpr])
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = colors.marker
    ctx.beginPath()
    ctx.moveTo(x, y - 5 * dpr); ctx.lineTo(x + 4 * dpr, y); ctx.lineTo(x, y + 5 * dpr); ctx.lineTo(x - 4 * dpr, y)
    ctx.closePath(); ctx.fill()
    ctx.font = `bold ${11 * dpr}px 'JetBrains Mono', monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    ctx.fillText(`${m.label} ${m.freq.toFixed(3)} ${db.toFixed(1)} dB`, x + 6 * dpr, y - 4 * dpr)
  })

  // Cursor
  if (opts.cursorX >= 0 && opts.cursorX <= 1) {
    const cx = pad.left + opts.cursorX * plotW
    ctx.strokeStyle = colors.cursor
    ctx.lineWidth = 1
    ctx.setLineDash([2 * dpr, 2 * dpr])
    ctx.beginPath(); ctx.moveTo(cx, pad.top); ctx.lineTo(cx, pad.top + plotH); ctx.stroke()
    ctx.setLineDash([])
  }

  // Return cursor info for overlay
  if (opts.cursorX >= 0 && opts.cursorX <= 1) {
    const cFreq = fMin + opts.cursorX * fSpan
    const cBin = Math.round(opts.cursorX * (n - 1))
    const cDb = (cBin >= 0 && cBin < n) ? d.live[cBin] : minDb
    return { cursorFreq: cFreq, cursorDb: cDb }
  }
  return null
}

import { useRef, useEffect, useState } from 'react'
import { useDecodeStore } from '../stores/decodeStore'
import { visibleTimeRange } from '../services/connection'
import { cmdColor, fmtDetail } from '../canvas/colors'

const FONT_STEPS = [9, 10, 11, 12, 13, 14, 16]

export function DecodeTable() {
  const log = useDecodeStore(s => s.log)
  const roundCount = useDecodeStore(s => s.roundCount)
  const containerRef = useRef<HTMLDivElement>(null)
  const [filtered, setFiltered] = useState(log)
  const userScrollRef = useRef(false)
  const [fontSize, setFontSize] = useState(11)

  // Sync filtered messages with visible time range at ~10 Hz
  useEffect(() => {
    const id = setInterval(() => {
      const { tMin, tMax } = visibleTimeRange
      if (tMin === 0 && tMax === 0) {
        setFiltered(log)
        return
      }
      const result = log.filter(m => m.timestamp && m.timestamp >= tMin && m.timestamp <= tMax)
      setFiltered(result)
    }, 100)
    return () => clearInterval(id)
  }, [log])

  // Auto-scroll to bottom when new filtered messages arrive (if user hasn't scrolled up)
  useEffect(() => {
    if (!userScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [filtered])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    userScrollRef.current = !atBottom
  }

  const zoomIn = () => {
    const idx = FONT_STEPS.indexOf(fontSize)
    if (idx < FONT_STEPS.length - 1) setFontSize(FONT_STEPS[idx + 1])
  }

  const zoomOut = () => {
    const idx = FONT_STEPS.indexOf(fontSize)
    if (idx > 0) setFontSize(FONT_STEPS[idx - 1])
  }

  const headerFontSize = Math.max(9, fontSize - 1)
  const cellPad = fontSize >= 13 ? '4px 10px' : '3px 8px'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 10px', fontSize: 11, opacity: 0.6, flexShrink: 0,
      }}>
        <span style={{ fontWeight: 500 }}>PROTOCOL DECODE LOG</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {filtered.length === log.length
            ? `${log.length} msgs | ${roundCount} rounds`
            : `${filtered.length} / ${log.length} msgs | ${roundCount} rounds`
          }
        </span>
      </div>
      <div ref={containerRef} onScroll={handleScroll} style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0,
        fontSize, fontFamily: 'var(--font-mono)',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-color)', fontSize: headerFontSize, opacity: 0.5 }}>
              <th style={{ ...thStyle, padding: cellPad }}>#</th>
              <th style={{ ...thStyle, padding: cellPad }}>Dir</th>
              <th style={{ ...thStyle, padding: cellPad }}>Command</th>
              <th style={{ ...thStyle, padding: cellPad }}>Round</th>
              <th style={{ ...thStyle, padding: cellPad }}>Freq</th>
              <th style={{ ...thStyle, padding: cellPad, textAlign: 'left' }}>Params</th>
              <th style={{ ...thStyle, padding: cellPad, textAlign: 'left' }}>EPC</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((msg, idx) => (
              <tr key={`${msg.id}-${idx}`} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ ...tdStyle, padding: cellPad, opacity: 0.4 }}>{msg.id}</td>
                <td style={{ ...tdStyle, padding: cellPad, color: msg.direction === 'R2T' ? '#ff6b35' : '#00ff88' }}>
                  {msg.direction === 'R2T' ? '\u2192' : '\u2190'}
                </td>
                <td style={{ ...tdStyle, padding: cellPad, color: cmdColor(msg.command), fontWeight: 600 }}>
                  {msg.command}
                </td>
                <td style={{ ...tdStyle, padding: cellPad, opacity: 0.5 }}>{msg.roundId}</td>
                <td style={{ ...tdStyle, padding: cellPad, opacity: 0.5 }}>{msg.freq.toFixed(1)}</td>
                <td style={{ ...tdStyle, padding: cellPad, textAlign: 'left', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fmtDetail(msg)}
                </td>
                <td style={{ ...tdStyle, padding: cellPad, textAlign: 'left', color: '#00d4ff', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {msg.tagEpc || ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{
        position: 'absolute', bottom: 10, right: 14,
        display: 'flex', gap: 3, zIndex: 5,
      }}>
        <button onClick={zoomOut} style={zoomBtnStyle} title="Decrease font size">-</button>
        <button onClick={zoomIn} style={zoomBtnStyle} title="Increase font size">+</button>
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'center', fontWeight: 400, whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  textAlign: 'center', whiteSpace: 'nowrap',
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

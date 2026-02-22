import { Button, Space } from 'antd'
import { useAppStore } from '../stores/appStore'
import { latestData } from '../services/connection'

export function MarkersPanel() {
  const markers = useAppStore(s => s.markers)
  const addMarker = useAppStore(s => s.addMarker)
  const removeMarker = useAppStore(s => s.removeMarker)
  const clearMarkers = useAppStore(s => s.clearMarkers)
  const setNextMarkerOnClick = useAppStore(s => s.setNextMarkerOnClick)
  const markerIdCounter = useAppStore(s => s.markerIdCounter)

  const handlePeakSearch = () => {
    if (!latestData) return
    const arr = latestData.live
    let maxIdx = 0
    for (let i = 1; i < arr.length; i++) { if (arr[i] > arr[maxIdx]) maxIdx = i }
    addMarker({ freq: latestData.freqs[maxIdx], label: `P${markerIdCounter + 1}` })
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={4} wrap>
        <Button size="small" onClick={() => setNextMarkerOnClick(true)} title="Place marker on click (M)">+ Marker</Button>
        <Button size="small" onClick={clearMarkers} title="Remove all markers">Clear</Button>
        <Button size="small" onClick={handlePeakSearch} title="Place marker at peak signal">Peak Search</Button>
      </Space>
      {markers.length > 0 && (
        <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {markers.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: '#ffcc00' }}>
              <span>{m.label}: {m.freq.toFixed(3)} MHz</span>
              <span style={{ cursor: 'pointer', color: '#ff3355' }} onClick={() => removeMarker(i)}>&times;</span>
            </div>
          ))}
        </div>
      )}
    </Space>
  )
}

import { Button, Divider, InputNumber, Slider, Space, Typography } from 'antd'
import { useAppStore } from '../stores/appStore'
import { send } from '../services/connection'

const { Text } = Typography

const SCALE_STEPS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5]

export function DisplayPanel() {
  const refLevel = useAppStore(s => s.refLevel)
  const dynRange = useAppStore(s => s.dynRange)
  const avgAlpha = useAppStore(s => s.avgAlpha)
  const showLive = useAppStore(s => s.showLive)
  const showAvg = useAppStore(s => s.showAvg)
  const showPeak = useAppStore(s => s.showPeak)
  const showFill = useAppStore(s => s.showFill)
  const showBands = useAppStore(s => s.showBands)
  const connectionMode = useAppStore(s => s.connectionMode)
  const uiScale = useAppStore(s => s.uiScale)
  const setUiScale = useAppStore(s => s.setUiScale)
  const setRefLevel = useAppStore(s => s.setRefLevel)
  const setDynRange = useAppStore(s => s.setDynRange)
  const setAvgAlpha = useAppStore(s => s.setAvgAlpha)
  const toggleTrace = useAppStore(s => s.toggleTrace)

  const zoomIn = () => {
    const idx = SCALE_STEPS.findIndex(s => s >= uiScale)
    const next = idx < SCALE_STEPS.length - 1 ? SCALE_STEPS[idx + 1] : SCALE_STEPS[SCALE_STEPS.length - 1]
    setUiScale(next)
  }

  const zoomOut = () => {
    const idx = SCALE_STEPS.findIndex(s => s >= uiScale)
    const next = idx > 0 ? SCALE_STEPS[idx - 1] : SCALE_STEPS[0]
    setUiScale(next)
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Row label="Ref Level (dB)">
        <InputNumber size="small" value={refLevel} onChange={(v) => v !== null && setRefLevel(v)}
          step={5} style={{ width: 80 }} />
      </Row>
      <Row label="Range (dB)">
        <InputNumber size="small" value={dynRange} onChange={(v) => v !== null && setDynRange(v)}
          step={10} min={20} max={150} style={{ width: 80 }} />
      </Row>
      <Row label="Averaging">
        <Slider min={0} max={100} step={1} value={Math.round(avgAlpha * 100)}
          onChange={(v) => { const a = v / 100; setAvgAlpha(a); send(connectionMode, { action: 'set_avg_alpha', value: a }) }}
          style={{ flex: 1, minWidth: 60 }} />
        <Text style={{ fontSize: 12, minWidth: 36, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{avgAlpha.toFixed(2)}</Text>
      </Row>
      <Divider style={{ margin: '4px 0' }} />
      <Text style={{ fontSize: 11, fontWeight: 500 }} type="secondary">Traces</Text>
      <Space size={4} wrap>
        <TraceBtn active={showLive} onClick={() => toggleTrace('showLive')} title="Toggle live trace">Live</TraceBtn>
        <TraceBtn active={showAvg} onClick={() => toggleTrace('showAvg')} title="Toggle average trace">Avg</TraceBtn>
        <TraceBtn active={showPeak} onClick={() => toggleTrace('showPeak')} title="Toggle peak hold trace">Peak</TraceBtn>
      </Space>
      <Space size={4} wrap>
        <TraceBtn active={showFill} onClick={() => toggleTrace('showFill')} title="Toggle spectrum fill">Fill</TraceBtn>
        <TraceBtn active={showBands} onClick={() => toggleTrace('showBands')} title="Toggle band overlays">Bands</TraceBtn>
        <Button size="small" onClick={() => send(connectionMode, { action: 'reset_peak' })} title="Reset peak hold data">Reset Peak</Button>
      </Space>
      <Divider style={{ margin: '4px 0' }} />
      <Row label="UI Scale">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Button size="small" onClick={zoomOut} style={{ width: 32, padding: 0 }}>-</Button>
          <span style={{ fontSize: 12, minWidth: 40, textAlign: 'center', cursor: 'pointer', fontFamily: 'var(--font-mono)' }}
            onClick={() => setUiScale(1.0)}>
            {Math.round(uiScale * 100)}%
          </span>
          <Button size="small" onClick={zoomIn} style={{ width: 32, padding: 0 }}>+</Button>
        </div>
      </Row>
    </Space>
  )
}

function TraceBtn({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <Button size="small" type={active ? 'primary' : 'default'} onClick={onClick} title={title}>
      {children}
    </Button>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }} type="secondary">{label}</Text>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, justifyContent: 'flex-end' }}>
        {children}
      </div>
    </div>
  )
}

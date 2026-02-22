import { Button, Space, Typography } from 'antd'
import { useAppStore } from '../stores/appStore'
import { send } from '../services/connection'

const { Text } = Typography

const QUICK_PRESETS = [
  { label: 'EU 866', freq: 866.6 },
  { label: 'US 915', freq: 915.0 },
  { label: 'AU 922', freq: 922.5 },
  { label: 'JP 918', freq: 918.6 },
]

export function PresetsPanel() {
  const bands = useAppStore(s => s.bands)
  const connectionMode = useAppStore(s => s.connectionMode)
  const setCenterFreq = useAppStore(s => s.setCenterFreq)

  const tune = (freq: number) => {
    setCenterFreq(freq)
    send(connectionMode, { action: 'set_center_freq', value: freq })
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={4} wrap>
        {QUICK_PRESETS.map(p => (
          <Button key={p.label} size="small" onClick={() => tune(p.freq)}>{p.label}</Button>
        ))}
      </Space>

      {Object.keys(bands).length > 0 && (
        <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12 }}>
          {Object.entries(bands).map(([name, b]) => (
            <div key={name} onClick={() => tune((b.start + b.end) / 2)}
              style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0',
                borderBottom: '1px solid var(--border-color)', cursor: 'pointer' }}>
              <Text style={{ fontSize: 12, fontWeight: 600 }}>{name}</Text>
              <Text style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} type="secondary">{b.start}–{b.end} MHz</Text>
            </div>
          ))}
        </div>
      )}
    </Space>
  )
}

import { Select, Typography } from 'antd'
import { useAppStore } from '../stores/appStore'
import { useDecodeStore } from '../stores/decodeStore'
import { getMockDecoder } from '../services/connection'

const { Text } = Typography

export function DecodePanelControls() {
  const connectionMode = useAppStore(s => s.connectionMode)
  const sequenceMode = useDecodeStore(s => s.sequenceMode)
  const setSequenceMode = useDecodeStore(s => s.setSequenceMode)

  const handleModeChange = (v: string) => {
    setSequenceMode(v)
    const mock = getMockDecoder()
    if (mock) mock.mode = v
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }} type="secondary">Mode</Text>
      <Select size="small" value={sequenceMode} onChange={handleModeChange} style={{ width: 120 }}
        options={[
          { value: 'reader-only', label: 'Reader Only' },
          { value: 'inventory', label: 'Inventory' },
          { value: 'access', label: 'Access' },
          { value: 'security', label: 'Security' },
          { value: 'gen2x', label: 'Gen2X' },
          { value: 'mixed', label: 'Mixed' },
        ]}
      />
    </div>
  )
}

import { InputNumber, Select, Slider, Space, Typography } from 'antd'
import { useAppStore } from '../stores/appStore'
import { send } from '../services/connection'

const { Text } = Typography

export function FrequencyPanel() {
  const centerFreq = useAppStore(s => s.centerFreq)
  const sampleRate = useAppStore(s => s.sampleRate)
  const gain = useAppStore(s => s.gain)
  const fftSize = useAppStore(s => s.fftSize)
  const connectionMode = useAppStore(s => s.connectionMode)
  const setCenterFreq = useAppStore(s => s.setCenterFreq)
  const setSampleRate = useAppStore(s => s.setSampleRate)
  const setGain = useAppStore(s => s.setGain)
  const setFftSize = useAppStore(s => s.setFftSize)

  const handleFreqChange = (v: number | null) => {
    if (!v) return
    setCenterFreq(v)
    send(connectionMode, { action: 'set_center_freq', value: v })
  }

  const handleRateChange = (v: string) => {
    const rate = parseFloat(v)
    setSampleRate(rate)
    send(connectionMode, { action: 'set_sample_rate', value: rate })
  }

  const handleGainChange = (v: number) => {
    setGain(v)
    send(connectionMode, { action: 'set_gain', value: v })
  }

  const handleFFTChange = (v: string) => {
    const size = parseInt(v)
    setFftSize(size)
    send(connectionMode, { action: 'set_fft_size', value: size })
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Row label="Center (MHz)">
        <InputNumber size="small" value={centerFreq} onChange={handleFreqChange}
          step={0.1} min={860} max={960} style={{ width: 100 }} />
      </Row>
      <Row label="Span (MHz)">
        <Select size="small" value={String(sampleRate)} onChange={handleRateChange} style={{ width: 100 }}
          options={[
            { value: '0.5', label: '0.5' }, { value: '1.0', label: '1.0' },
            { value: '1.4', label: '1.4' }, { value: '2.0', label: '2.0' },
            { value: '2.4', label: '2.4' },
          ]}
        />
      </Row>
      <Row label="Gain (dB)">
        <Slider min={0} max={50} step={1} value={gain} onChange={handleGainChange} style={{ flex: 1, minWidth: 60 }} />
        <Text style={{ fontSize: 12, minWidth: 28, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{gain}</Text>
      </Row>
      <Row label="FFT Size">
        <Select size="small" value={String(fftSize)} onChange={handleFFTChange} style={{ width: 100 }}
          options={[
            { value: '256', label: '256' }, { value: '512', label: '512' },
            { value: '1024', label: '1024' }, { value: '2048', label: '2048' },
            { value: '4096', label: '4096' },
          ]}
        />
      </Row>
    </Space>
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

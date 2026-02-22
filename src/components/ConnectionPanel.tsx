import { Button, InputNumber, Space, Typography, Modal } from 'antd'
import { UsbOutlined, WifiOutlined, PlayCircleOutlined, ApiOutlined } from '@ant-design/icons'
import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { useDecodeStore } from '../stores/decodeStore'
import * as conn from '../services/connection'

const { Text } = Typography

export function ConnectionPanel() {
  const connectionMode = useAppStore(s => s.connectionMode)
  const connected = useAppStore(s => s.connected)
  const wsPort = useAppStore(s => s.wsPort)
  const setWsPort = useAppStore(s => s.setWsPort)
  const setConnectionMode = useAppStore(s => s.setConnectionMode)
  const setConnected = useAppStore(s => s.setConnected)
  const setBands = useAppStore(s => s.setBands)
  const push = useDecodeStore(s => s.push)
  const decodeEnabled = useDecodeStore(s => s.enabled)
  const [showPicker, setShowPicker] = useState(false)
  const [usbStatus, setUsbStatus] = useState('')

  const getConfig = () => {
    const s = useAppStore.getState()
    return { centerFreq: s.centerFreq, sampleRate: s.sampleRate, gain: s.gain, fftSize: s.fftSize, avgAlpha: s.avgAlpha }
  }

  const handleConnectWS = () => {
    conn.disconnectUSB()
    conn.disconnectMock()
    setConnectionMode('ws')
    conn.connectWS(
      wsPort,
      () => setConnected(true, 'WS Connected'),
      () => setConnected(false, 'Disconnected'),
      (data) => { if (data.bands) setBands(data.bands) },
    )
  }

  const handleConnectUSB = () => {
    if (connected && (connectionMode === 'webusb' || connectionMode === 'mock')) {
      handleDisconnect()
      return
    }
    setShowPicker(true)
  }

  const handlePickSimulated = () => {
    setShowPicker(false)
    conn.disconnectWS()
    conn.disconnectUSB()
    setConnectionMode('mock')
    const onDecodeMsg = (msg: Parameters<typeof push>[0]) => push(msg)
    conn.connectMock(getConfig, (data) => { if (data.bands) setBands(data.bands) }, onDecodeMsg)
    setConnected(true, 'Simulated RTL-SDR')
    setUsbStatus('Connected (Simulated RTL-SDR)')
  }

  const handlePickUSB = async () => {
    setShowPicker(false)
    conn.disconnectWS()
    conn.disconnectMock()
    setConnectionMode('webusb')
    setUsbStatus('Requesting USB device...')
    await conn.connectUSB(
      getConfig(),
      (tunerType) => {
        setConnected(true, `USB: ${tunerType}`)
        setUsbStatus(`Connected (${tunerType})`)
      },
      (data) => { if (data.bands) setBands(data.bands) },
      (err) => {
        setConnected(false, 'USB Error')
        setUsbStatus(`Error: ${err.message}`)
      },
      decodeEnabled,
      (msg) => push(msg),
    )
  }

  const handleDisconnect = () => {
    if (connectionMode === 'mock') conn.disconnectMock()
    else if (connectionMode === 'webusb') conn.disconnectUSB()
    else conn.disconnectWS()
    setConnected(false, 'Disconnected')
    setConnectionMode('disconnected')
    setUsbStatus('')
  }

  const hasWebUSB = typeof navigator !== 'undefined' && 'usb' in navigator

  return (
    <>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={4} wrap>
          <Button
            size="small" icon={<WifiOutlined />}
            type={connectionMode === 'ws' ? 'primary' : 'default'}
            onClick={handleConnectWS}
            title="Connect via WebSocket"
          >WS</Button>
          <Button
            size="small" icon={<UsbOutlined />}
            type={(connectionMode === 'webusb' || connectionMode === 'mock') ? 'primary' : 'default'}
            danger={connected && (connectionMode === 'webusb' || connectionMode === 'mock')}
            onClick={handleConnectUSB}
            title={connected && (connectionMode === 'webusb' || connectionMode === 'mock') ? 'Disconnect USB device' : 'Connect via WebUSB or simulation'}
          >{connected && (connectionMode === 'webusb' || connectionMode === 'mock') ? 'Disconnect' : 'USB'}</Button>
        </Space>

        {connectionMode === 'ws' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <Text style={{ fontSize: 12 }}>WS Port</Text>
            <InputNumber size="small" value={wsPort} onChange={(v) => { if (v) setWsPort(v) }}
              style={{ width: 80 }} min={1} max={65535} />
          </div>
        )}

        {usbStatus && (
          <Text style={{ fontSize: 11, display: 'block' }}
            type={usbStatus.includes('Error') ? 'danger' : usbStatus.includes('Connected') ? 'success' : 'secondary'}>
            {usbStatus}
          </Text>
        )}
      </Space>

      <Modal
        title="Select RTL-SDR Device"
        open={showPicker}
        onCancel={() => setShowPicker(false)}
        footer={null}
        width={360}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Button block icon={<PlayCircleOutlined />} onClick={handlePickSimulated}>
            Simulated RTL-SDR
            <Text style={{ fontSize: 11, display: 'block' }} type="secondary">Demo mode - synthetic RFID data</Text>
          </Button>
          <Button block icon={<ApiOutlined />} onClick={handlePickUSB} disabled={!hasWebUSB}>
            Scan for USB Devices
            <Text style={{ fontSize: 11, display: 'block' }} type="secondary">
              {hasWebUSB ? 'Connect a physical RTL-SDR via WebUSB' : 'Requires Chrome/Edge'}
            </Text>
          </Button>
        </Space>
      </Modal>
    </>
  )
}

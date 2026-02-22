/**
 * WebUSB RTL-SDR Driver
 *
 * Provides direct browser-to-RTL-SDR communication via the WebUSB API.
 * Converted from webusb-rtlsdr.js to an ES module.
 */

// RTL2832U USB constants
const RTL2832U_VENDOR_ID = 0x0bda
const RTL2832U_PRODUCT_IDS = [0x2832, 0x2838]

// R820T register constants
const R820T_I2C_ADDR = 0x34
const R820T_CHECK_VAL = 0x69
const R820T_IF_FREQ = 3570000 // 3.57 MHz IF

// R820T initial register values (regs 0x05–0x1F)
const R820T_INIT_REGS = [
  0x83, 0x32, 0x75,
  0xc0, 0x40, 0xd6, 0x6c,
  0xf5, 0x63, 0x75, 0x68,
  0x6c, 0x83, 0x80, 0x00,
  0x0f, 0x00, 0xc0, 0x30,
  0x48, 0xcc, 0x60, 0x00,
  0x54, 0xae, 0x4a, 0xc0,
]

export class WebUSBRtlSDR {
  device: any = null
  isOpen = false
  centerFreq = 915e6
  sampleRate = 2.4e6
  gain = 40
  tunerType: string | null = null
  _r820tRegs = new Uint8Array(32)
  _xtalFreq = 28800000

  async open() {
    if (!(navigator as any).usb) {
      throw new Error('WebUSB is not supported in this browser. Use Chrome, Edge, or Opera.')
    }
    this.device = await (navigator as any).usb.requestDevice({
      filters: RTL2832U_PRODUCT_IDS.map(pid => ({
        vendorId: RTL2832U_VENDOR_ID,
        productId: pid,
      })),
    })
    await this.device.open()
    if (this.device.configuration === null || this.device.configuration.configurationValue !== 1) {
      await this.device.selectConfiguration(1)
    }
    await this.device.claimInterface(0)
    await this._initDemod()
    await this._initTuner()
    await this.setCenterFreq(this.centerFreq)
    await this.setSampleRate(this.sampleRate)
    await this.setGain(this.gain)
    await this._resetEndpoint()
    this.isOpen = true
    return true
  }

  async close() {
    if (this.device) {
      try {
        await this.device.releaseInterface(0)
        await this.device.close()
      } catch (e) {
        console.warn('[WebUSB-RTL-SDR] Error closing device:', e)
      }
      this.device = null
      this.isOpen = false
    }
  }

  async setCenterFreq(freq: number) {
    this.centerFreq = freq
    if (!this.device) return
    const tunerFreq = freq + R820T_IF_FREQ
    await this._r820tSetFreq(tunerFreq)
    await this._setIfFreq(R820T_IF_FREQ)
  }

  async setSampleRate(rate: number) {
    this.sampleRate = rate
    if (!this.device) return
    const realRsampRatio = Math.floor((this._xtalFreq * Math.pow(2, 22)) / rate)
    const ratioInt = (realRsampRatio >> 16) & 0xffff
    const ratioFrac = realRsampRatio & 0xffff
    await this._demodWriteReg(1, 0x9f, (ratioInt >> 8) & 0xff)
    await this._demodWriteReg(1, 0xa0, ratioInt & 0xff)
    await this._demodWriteReg(1, 0xa1, (ratioFrac >> 8) & 0xff)
    await this._demodWriteReg(1, 0xa2, ratioFrac & 0xff)
    await this._r820tSetBandwidth(rate)
  }

  async setGain(gain: number) {
    this.gain = gain
    if (!this.device) return
    await this._demodWriteReg(1, 0x19, 0x20)
    const gainTable = [0, 9, 13, 40, 77, 87, 100, 115, 150, 174, 197, 238, 280, 340, 389, 430, 442, 448, 480, 496]
    const targetTenths = Math.round(gain * 10)
    let bestIdx = 0
    let bestDiff = Math.abs(gainTable[0] - targetTenths)
    for (let i = 1; i < gainTable.length; i++) {
      const diff = Math.abs(gainTable[i] - targetTenths)
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i }
    }
    const lnaGain = Math.min(bestIdx, 15)
    await this._r820tWriteReg(0x05, (lnaGain & 0x0f) | 0x10)
    const mixerGain = Math.min(Math.floor(bestIdx / 2), 15)
    await this._r820tWriteReg(0x07, (mixerGain & 0x0f) | 0x10)
  }

  async readSamples(numSamples: number): Promise<Float32Array> {
    if (!this.device || !this.isOpen) throw new Error('Device not open')
    const bytesNeeded = numSamples * 2
    const blockSize = 16384
    const totalBytes = Math.ceil(bytesNeeded / blockSize) * blockSize
    const buffer = new Uint8Array(totalBytes)
    let offset = 0
    while (offset < totalBytes) {
      const chunkSize = Math.min(blockSize, totalBytes - offset)
      try {
        const result = await this.device.transferIn(1, chunkSize)
        const data = new Uint8Array(result.data!.buffer)
        buffer.set(data, offset)
        offset += data.length
      } catch (e) {
        console.error('[WebUSB-RTL-SDR] Read error:', e)
        break
      }
    }
    const iq = new Float32Array(numSamples * 2)
    for (let i = 0; i < numSamples * 2; i++) {
      iq[i] = (buffer[i] - 127.5) / 127.5
    }
    return iq
  }

  getGains() {
    return [0, 0.9, 1.3, 4.0, 7.7, 8.7, 10.0, 11.5, 15.0, 17.4, 19.7, 23.8, 28.0, 34.0, 38.9, 43.0, 44.2, 44.8, 48.0, 49.6]
  }

  // ---- RTL2832U demod internals ----

  async _ctrlTransferOut(value: number, index: number, data: number[] | Uint8Array) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
    await this.device!.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, buf)
  }

  async _ctrlTransferIn(value: number, index: number, length: number) {
    const result = await this.device!.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value, index }, length)
    return new Uint8Array(result.data!.buffer)
  }

  async _writeReg(block: number, addr: number, val: number, len = 1) {
    const index = (block << 8) | 0x10
    const data = new Uint8Array(len)
    if (len === 1) data[0] = val & 0xff
    else if (len === 2) { data[0] = (val >> 8) & 0xff; data[1] = val & 0xff }
    await this._ctrlTransferOut(addr, index, data)
  }

  async _readReg(block: number, addr: number, len = 1) {
    const index = block << 8
    const data = await this._ctrlTransferIn(addr, index, len)
    if (len === 1) return data[0]
    return (data[0] << 8) | data[1]
  }

  async _demodWriteReg(page: number, addr: number, val: number) {
    const realAddr = (addr << 8) | 0x20
    await this._writeReg(page, realAddr, val)
    await this._readDemodReg(page, 0x01)
  }

  async _readDemodReg(page: number, addr: number) {
    const realAddr = (addr << 8) | 0x20
    return await this._readReg(page, realAddr)
  }

  async _initDemod() {
    await this._writeReg(0, 0x0008, 0x4d, 1)
    await this._writeReg(0, 0x0009, 0xcd, 1)
    await this._demodWriteReg(1, 0x01, 0x14)
    await this._demodWriteReg(1, 0x01, 0x10)
    await this._demodWriteReg(1, 0x15, 0x00)
    await this._demodWriteReg(1, 0x16, 0x00)
    await this._demodWriteReg(1, 0x19, 0x25)
    await this._demodWriteReg(1, 0x1a, 0x00)
    await this._setI2CRepeater(true)
  }

  async _setI2CRepeater(on: boolean) {
    await this._demodWriteReg(1, 0x01, on ? 0x18 : 0x10)
  }

  async _resetEndpoint() {
    await this._writeReg(0, 0x0009, 0xc0, 1)
    await this._writeReg(0, 0x0009, 0xcd, 1)
  }

  async _setIfFreq(freq: number) {
    const ifFreqScaled = Math.round((-freq * Math.pow(2, 22)) / this._xtalFreq)
    const val = ifFreqScaled & 0x3fffff
    await this._demodWriteReg(1, 0x19, (val >> 16) & 0x3f)
    await this._demodWriteReg(1, 0x1a, (val >> 8) & 0xff)
    await this._demodWriteReg(1, 0x1b, val & 0xff)
  }

  async _initTuner() {
    await this._setI2CRepeater(true)
    try {
      const val = await this._i2cRead(R820T_I2C_ADDR, 1)
      this.tunerType = val[0] === R820T_CHECK_VAL ? 'R820T' : 'R820T2'
    } catch {
      this.tunerType = 'R820T'
    }
    for (let i = 0; i < R820T_INIT_REGS.length; i++) {
      this._r820tRegs[i + 5] = R820T_INIT_REGS[i]
      await this._r820tWriteRegDirect(i + 5, R820T_INIT_REGS[i])
    }
    await this._r820tWriteReg(0x06, 0x32)
    await this._r820tWriteReg(0x1d, 0x00)
    await this._r820tWriteReg(0x1c, 0x54)
    await this._setI2CRepeater(false)
  }

  async _i2cWrite(addr: number, data: number[] | Uint8Array) {
    const index = 0x0600 | 0x10
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
    await this.device!.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value: addr, index }, buf)
  }

  async _i2cRead(addr: number, len: number) {
    const result = await this.device!.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: 0x0600 }, len)
    return new Uint8Array(result.data!.buffer)
  }

  async _r820tWriteRegDirect(reg: number, val: number) {
    await this._setI2CRepeater(true)
    await this._i2cWrite(R820T_I2C_ADDR, [reg, val])
  }

  async _r820tWriteReg(reg: number, val: number) {
    this._r820tRegs[reg] = val
    await this._setI2CRepeater(true)
    await this._i2cWrite(R820T_I2C_ADDR, [reg, val])
  }

  async _r820tWriteRegMask(reg: number, val: number, mask: number) {
    const old = this._r820tRegs[reg] || 0
    const newVal = (old & ~mask) | (val & mask)
    await this._r820tWriteReg(reg, newVal)
  }

  async _r820tSetFreq(freq: number) {
    await this._setI2CRepeater(true)
    let mixDiv = 2
    let divNum = 0
    while (mixDiv <= 64) {
      if (freq * mixDiv >= 1770e6) break
      mixDiv *= 2
      divNum++
    }
    await this._r820tWriteRegMask(0x10, divNum << 5, 0xe0)
    const vcoFreq = freq * mixDiv
    const nint = Math.floor(vcoFreq / (2 * this._xtalFreq))
    if (nint > 127) {
      const ni = Math.floor(nint / 4)
      await this._r820tWriteReg(0x14, (ni & 0xff) | 0x10)
    } else {
      await this._r820tWriteReg(0x14, nint & 0xff)
    }
    const vcoFrac = vcoFreq - 2 * this._xtalFreq * nint
    const sdm = Math.round((vcoFrac * 65536) / (2 * this._xtalFreq))
    await this._r820tWriteReg(0x12, (sdm >> 8) & 0xff)
    await this._r820tWriteReg(0x13, sdm & 0xff)
    await this._sleep(10)
    await this._setI2CRepeater(false)
  }

  async _r820tSetBandwidth(rate: number) {
    await this._setI2CRepeater(true)
    let filterBw: number
    if (rate < 300e3) filterBw = 0x0f
    else if (rate < 600e3) filterBw = 0x0e
    else if (rate < 1e6) filterBw = 0x0d
    else if (rate < 1.5e6) filterBw = 0x0a
    else if (rate < 2e6) filterBw = 0x08
    else filterBw = 0x04
    await this._r820tWriteRegMask(0x0a, filterBw, 0x0f)
    await this._setI2CRepeater(false)
  }

  _sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export interface SpectrumResult {
  type: 'spectrum'
  freqs: number[]
  live: number[]
  avg: number[]
  peak: number[]
  center_freq: number
  sample_rate: number
  gain: number
  fft_size: number
  bands: Record<string, { start: number; end: number; channels: number; power: string }>
}

const BANDS = {
  'FCC (US)': { start: 902.0, end: 928.0, channels: 50, power: '1W ERP' },
  'ETSI (EU)': { start: 865.6, end: 867.6, channels: 4, power: '2W ERP' },
  China: { start: 920.0, end: 925.0, channels: 16, power: '2W ERP' },
  Japan: { start: 916.8, end: 920.4, channels: 9, power: '250mW' },
  Korea: { start: 917.0, end: 923.5, channels: 13, power: '200mW' },
  Brazil: { start: 902.0, end: 907.5, channels: 11, power: '4W EIRP' },
  Australia: { start: 920.0, end: 926.0, channels: 12, power: '1W EIRP' },
}

export class WebUSBSpectrumAnalyzer {
  sdr = new WebUSBRtlSDR()
  fftSize = 1024
  running = false
  onSpectrum: ((data: SpectrumResult) => void) | null = null
  decodeEnabled = false
  decodeSamples = 32768
  onRawIQ: ((iq: Float32Array) => void) | null = null
  avgBuffer: Float32Array | null = null
  avgAlpha = 0.3
  peakHold: Float32Array | null = null
  _window: Float32Array
  _pieDecoder: { setCenterFreq: (mhz: number) => void; reset: () => void } | null = null

  constructor() {
    this._window = new Float32Array(0)
    this._updateWindow()
  }

  _updateWindow() {
    const N = this.fftSize
    this._window = new Float32Array(N)
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168
    for (let n = 0; n < N; n++) {
      this._window[n] = a0 - a1 * Math.cos(2 * Math.PI * n / (N - 1)) + a2 * Math.cos(4 * Math.PI * n / (N - 1)) - a3 * Math.cos(6 * Math.PI * n / (N - 1))
    }
  }

  async open() { await this.sdr.open() }
  async close() { this.running = false; await this.sdr.close() }
  setCenterFreq(freqMHz: number) { this.sdr.setCenterFreq(freqMHz * 1e6) }
  setSampleRate(rateMHz: number) { this.sdr.setSampleRate(rateMHz * 1e6) }
  setGain(gain: number) { this.sdr.setGain(gain) }
  setFFTSize(size: number) { this.fftSize = size; this._updateWindow(); this.avgBuffer = null; this.peakHold = null }
  resetPeakHold() { this.peakHold = null }

  async start(fps = 20) {
    this.running = true
    const interval = 1000 / fps
    while (this.running) {
      const t0 = performance.now()
      try {
        if (this.decodeEnabled && this.onRawIQ) {
          const numSamples = Math.max(this.fftSize, this.decodeSamples)
          const iq = await this.sdr.readSamples(numSamples)
          const fftIQ = iq.subarray(0, this.fftSize * 2)
          const result = this._processFFT(fftIQ)
          if (this.onSpectrum) this.onSpectrum(result)
          this.onRawIQ(iq)
        } else {
          const iq = await this.sdr.readSamples(this.fftSize)
          const result = this._processFFT(iq)
          if (this.onSpectrum) this.onSpectrum(result)
        }
      } catch (e) {
        console.error('[WebUSB Analyzer] Read error:', e)
      }
      const elapsed = performance.now() - t0
      if (elapsed < interval) await new Promise(r => setTimeout(r, interval - elapsed))
    }
  }

  _processFFT(iq: Float32Array): SpectrumResult {
    const N = this.fftSize
    const re = new Float32Array(N)
    const im = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      re[i] = iq[i * 2] * this._window[i]
      im[i] = iq[i * 2 + 1] * this._window[i]
    }
    this._fft(re, im)
    const half = N >> 1
    for (let i = 0; i < half; i++) {
      ;[re[i], re[i + half]] = [re[i + half], re[i]]
      ;[im[i], im[i + half]] = [im[i + half], im[i]]
    }
    const live = new Float32Array(N)
    const log10N = 10 * Math.log10(N)
    for (let i = 0; i < N; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i])
      live[i] = 20 * Math.log10(Math.max(mag, 1e-15)) - log10N
    }
    if (!this.avgBuffer || this.avgBuffer.length !== N) {
      this.avgBuffer = live.slice()
    } else {
      const a = this.avgAlpha, b = 1 - a
      for (let i = 0; i < N; i++) this.avgBuffer[i] = a * live[i] + b * this.avgBuffer[i]
    }
    if (!this.peakHold || this.peakHold.length !== N) {
      this.peakHold = live.slice()
    } else {
      for (let i = 0; i < N; i++) if (live[i] > this.peakHold[i]) this.peakHold[i] = live[i]
    }
    const fc = this.sdr.centerFreq
    const fs = this.sdr.sampleRate
    const freqs = new Float32Array(N)
    for (let i = 0; i < N; i++) freqs[i] = (fc - fs / 2 + (i / N) * fs) / 1e6
    return {
      type: 'spectrum',
      freqs: Array.from(freqs), live: Array.from(live), avg: Array.from(this.avgBuffer), peak: Array.from(this.peakHold),
      center_freq: fc / 1e6, sample_rate: fs / 1e6, gain: this.sdr.gain, fft_size: N, bands: BANDS,
    }
  }

  _fft(re: Float32Array, im: Float32Array) {
    const N = re.length
    if (N <= 1) return
    let j = 0
    for (let i = 0; i < N - 1; i++) {
      if (i < j) { ;[re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
      let k = N >> 1
      while (k <= j) { j -= k; k >>= 1 }
      j += k
    }
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1
      const angle = -2 * Math.PI / len
      const wRe = Math.cos(angle), wIm = Math.sin(angle)
      for (let i = 0; i < N; i += len) {
        let curRe = 1, curIm = 0
        for (let k = 0; k < halfLen; k++) {
          const tRe = curRe * re[i + k + halfLen] - curIm * im[i + k + halfLen]
          const tIm = curRe * im[i + k + halfLen] + curIm * re[i + k + halfLen]
          re[i + k + halfLen] = re[i + k] - tRe
          im[i + k + halfLen] = im[i + k] - tIm
          re[i + k] += tRe
          im[i + k] += tIm
          const newCurRe = curRe * wRe - curIm * wIm
          curIm = curRe * wIm + curIm * wRe
          curRe = newCurRe
        }
      }
    }
  }
}

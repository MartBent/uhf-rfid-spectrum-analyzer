/**
 * Mock SDR Spectrum Generator
 * Generates synthetic UHF RFID spectrum data for demo/development.
 */

import type { SpectrumData, BandInfo } from '../stores/appStore'

const DEFAULT_TAGS = [
  { freq: 902.75, amplitude: 0.08 },
  { freq: 910.0, amplitude: 0.10 },
  { freq: 915.25, amplitude: 0.12 },
  { freq: 920.0, amplitude: 0.06 },
  { freq: 926.0, amplitude: 0.07 },
]

const BANDS: Record<string, BandInfo> = {
  'FCC (US)': { start: 902.0, end: 928.0, channels: 50, power: '1W ERP' },
  'ETSI (EU)': { start: 865.6, end: 867.6, channels: 4, power: '2W ERP' },
  China: { start: 920.0, end: 925.0, channels: 16, power: '2W ERP' },
  Japan: { start: 916.8, end: 920.4, channels: 9, power: '250mW' },
  Korea: { start: 917.0, end: 923.5, channels: 13, power: '200mW' },
  Brazil: { start: 902.0, end: 907.5, channels: 11, power: '4W EIRP' },
  Australia: { start: 920.0, end: 926.0, channels: 12, power: '1W EIRP' },
}

export class MockSpectrumGenerator {
  private _noiseFloor = -90
  private _avgBuffer: number[] | null = null
  private _peakHold: number[] | null = null

  generateFrame(centerFreq: number, sampleRate: number, gain: number, fftSize: number, avgAlpha: number): SpectrumData {
    const t = performance.now() / 1000
    const fMin = centerFreq - sampleRate / 2
    const fMax = centerFreq + sampleRate / 2

    const freqs = new Array(fftSize)
    for (let i = 0; i < fftSize; i++) {
      freqs[i] = fMin + (i / (fftSize - 1)) * sampleRate
    }

    const live = new Array(fftSize)
    for (let i = 0; i < fftSize; i++) {
      live[i] = this._noiseFloor + (Math.random() - 0.5) * 6
    }

    for (const tag of DEFAULT_TAGS) {
      if (tag.freq < fMin || tag.freq > fMax) continue
      const ampVar = tag.amplitude + tag.amplitude * 0.5 * Math.sin(2 * Math.PI * 0.3 * t + tag.freq)
      const signalDb = this._noiseFloor + 20 + ampVar * 400
      const binCenter = ((tag.freq - fMin) / sampleRate) * (fftSize - 1)
      const spread = Math.max(2, Math.round(fftSize * 0.003))
      for (let j = -spread; j <= spread; j++) {
        const bin = Math.round(binCenter) + j
        if (bin >= 0 && bin < fftSize) {
          const rolloff = Math.exp(-0.5 * (j / (spread * 0.4)) ** 2)
          live[bin] = Math.max(live[bin], signalDb * rolloff + this._noiseFloor * (1 - rolloff))
        }
      }
    }

    const readerCenter = 915.0
    if (readerCenter >= fMin && readerCenter <= fMax) {
      const readerBw = 0.5
      const binCenter = ((readerCenter - fMin) / sampleRate) * (fftSize - 1)
      const spreadBins = Math.round((readerBw / sampleRate) * fftSize / 2)
      const readerAmplitude = 1 + 0.3 * Math.sin(2 * Math.PI * 1.7 * t)
      for (let j = -spreadBins; j <= spreadBins; j++) {
        const bin = Math.round(binCenter) + j
        if (bin >= 0 && bin < fftSize) {
          const bump = 12 * readerAmplitude * Math.exp(-0.5 * (j / (spreadBins * 0.4)) ** 2)
          live[bin] += bump
        }
      }
    }

    if (!this._avgBuffer || this._avgBuffer.length !== fftSize) {
      this._avgBuffer = live.slice()
    } else {
      for (let i = 0; i < fftSize; i++) {
        this._avgBuffer[i] = avgAlpha * live[i] + (1 - avgAlpha) * this._avgBuffer[i]
      }
    }

    if (!this._peakHold || this._peakHold.length !== fftSize) {
      this._peakHold = live.slice()
    } else {
      for (let i = 0; i < fftSize; i++) {
        if (live[i] > this._peakHold[i]) this._peakHold[i] = live[i]
      }
    }

    return {
      freqs,
      live,
      avg: this._avgBuffer.slice(),
      peak: this._peakHold.slice(),
      center_freq: centerFreq,
      sample_rate: sampleRate,
      gain,
      fft_size: fftSize,
      bands: BANDS,
    }
  }

  resetPeak() {
    this._peakHold = null
  }
}

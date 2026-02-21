/**
 * WebUSB RTL-SDR Driver
 *
 * Provides direct browser-to-RTL-SDR communication via the WebUSB API,
 * eliminating the need for a Python backend. Implements the RTL2832U
 * demodulator register protocol and R820T/R820T2 tuner control.
 *
 * Usage:
 *   const sdr = new WebUSBRtlSDR();
 *   await sdr.open();
 *   sdr.setCenterFreq(915e6);
 *   sdr.setSampleRate(2.4e6);
 *   const iq = await sdr.readSamples(1024);
 *   await sdr.close();
 *
 * Requirements:
 *   - Browser with WebUSB support (Chrome, Edge, Opera)
 *   - RTL-SDR dongle with RTL2832U + R820T/R820T2
 *   - HTTPS or localhost (WebUSB security requirement)
 *   - On Linux: udev rule or user permission for the USB device
 */

// RTL2832U USB constants
const RTL2832U_VENDOR_ID  = 0x0bda;
const RTL2832U_PRODUCT_IDS = [0x2832, 0x2838];  // common RTL-SDR product IDs
const BULK_EP_IN = 0x81;   // endpoint 1 IN (bulk)
const CTRL_TIMEOUT = 5000;

// RTL2832U register blocks
const BLOCK = {
  DEMOD: 0x0000,
  USB:   0x0100,
  SYS:   0x0200,
  I2C:   0x0600,
};

// RTL2832U register addresses
const REG = {
  // USB block
  USB_SYSCTL:       0x2000,
  USB_SYSCTL_0:     0x2000,
  USB_EPA_CFG:      0x2148,
  USB_EPA_CTL:      0x2148,
  USB_EPA_MAXPKT:   0x2158,
  // Demod block
  DEMOD_CTL:        0x3000,
  DEMOD_CTL_1:      0x300B,
  // System block
  SYS_DEMOD_CTL:    0x3000,
  SYS_DEMOD_CTL_1:  0x300B,
  GPO:              0x0001,
  GPI:              0x0000,
  GPOE:             0x0003,
  GPD:              0x0004,
};

// R820T register constants
const R820T_I2C_ADDR = 0x34;
const R820T_CHECK_ADDR = 0x00;
const R820T_CHECK_VAL  = 0x69;
const R820T_IF_FREQ    = 3570000;   // 3.57 MHz IF

// R820T initial register values (regs 0x05–0x1F)
const R820T_INIT_REGS = [
  0x83, 0x32, 0x75,                         // 0x05–0x07
  0xC0, 0x40, 0xD6, 0x6C,                   // 0x08–0x0B
  0xF5, 0x63, 0x75, 0x68,                   // 0x0C–0x0F
  0x6C, 0x83, 0x80, 0x00,                   // 0x10–0x13
  0x0F, 0x00, 0xC0, 0x30,                   // 0x14–0x17
  0x48, 0xCC, 0x60, 0x00,                   // 0x18–0x1B
  0x54, 0xAE, 0x4A, 0xC0,                   // 0x1C–0x1F
];


class WebUSBRtlSDR {
  constructor() {
    this.device = null;
    this.isOpen = false;
    this.centerFreq = 915e6;
    this.sampleRate = 2.4e6;
    this.gain = 40;
    this.tunerType = null;  // 'R820T' or 'R820T2'
    this._r820tRegs = new Uint8Array(32);
    this._xtalFreq = 28800000;  // 28.8 MHz
  }

  // ---- Public API ----

  /**
   * Request and open the RTL-SDR device via WebUSB.
   */
  async open() {
    if (!navigator.usb) {
      throw new Error('WebUSB is not supported in this browser. Use Chrome, Edge, or Opera.');
    }

    // Request device from user
    this.device = await navigator.usb.requestDevice({
      filters: RTL2832U_PRODUCT_IDS.map(pid => ({
        vendorId: RTL2832U_VENDOR_ID,
        productId: pid,
      })),
    });

    await this.device.open();

    // Select configuration 1 if not already
    if (this.device.configuration === null ||
        this.device.configuration.configurationValue !== 1) {
      await this.device.selectConfiguration(1);
    }

    // Claim interface 0
    await this.device.claimInterface(0);

    // Initialize RTL2832U demodulator
    await this._initDemod();

    // Detect and initialize tuner
    await this._initTuner();

    // Apply default settings
    await this.setCenterFreq(this.centerFreq);
    await this.setSampleRate(this.sampleRate);
    await this.setGain(this.gain);

    // Reset endpoint buffer
    await this._resetEndpoint();

    this.isOpen = true;
    console.log('[WebUSB-RTL-SDR] Device opened successfully');
    return true;
  }

  /**
   * Close the device.
   */
  async close() {
    if (this.device) {
      try {
        await this.device.releaseInterface(0);
        await this.device.close();
      } catch (e) {
        console.warn('[WebUSB-RTL-SDR] Error closing device:', e);
      }
      this.device = null;
      this.isOpen = false;
    }
  }

  /**
   * Set center frequency in Hz.
   */
  async setCenterFreq(freq) {
    this.centerFreq = freq;
    if (!this.device) return;

    // Set tuner frequency (tuner tunes to freq + IF)
    const tunerFreq = freq + R820T_IF_FREQ;
    await this._r820tSetFreq(tunerFreq);

    // Set RTL2832U IF frequency
    await this._setIfFreq(R820T_IF_FREQ);
  }

  /**
   * Set sample rate in Hz.
   */
  async setSampleRate(rate) {
    this.sampleRate = rate;
    if (!this.device) return;

    // Calculate decimation ratio
    let realRate = 0;
    const realRsampRatio = Math.floor((this._xtalFreq * Math.pow(2, 22)) / rate);
    const ratioInt = (realRsampRatio >> 16) & 0xFFFF;
    const ratioFrac = realRsampRatio & 0xFFFF;

    if (ratioInt > 0) {
      realRate = (this._xtalFreq * Math.pow(2, 22)) / realRsampRatio;
    }

    // Write sample rate registers
    await this._demodWriteReg(1, 0x9F, (ratioInt >> 8) & 0xFF);
    await this._demodWriteReg(1, 0xA0, ratioInt & 0xFF);
    await this._demodWriteReg(1, 0xA1, (ratioFrac >> 8) & 0xFF);
    await this._demodWriteReg(1, 0xA2, ratioFrac & 0xFF);

    // Set bandwidth
    await this._r820tSetBandwidth(rate);
  }

  /**
   * Set tuner gain in dB (0–50).
   */
  async setGain(gain) {
    this.gain = gain;
    if (!this.device) return;

    // Enable manual gain mode
    await this._demodWriteReg(1, 0x19, 0x20);  // manual AGC

    // R820T gain table (approximate LNA + mixer gain in tenths of dB)
    const gainTable = [
      0, 9, 13, 40, 77, 87, 100, 115, 150, 174,
      197, 238, 280, 340, 389, 430, 442, 448, 480, 496,
    ];

    // Find nearest gain entry
    const targetTenths = Math.round(gain * 10);
    let bestIdx = 0;
    let bestDiff = Math.abs(gainTable[0] - targetTenths);
    for (let i = 1; i < gainTable.length; i++) {
      const diff = Math.abs(gainTable[i] - targetTenths);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }

    // Set LNA gain
    const lnaGain = Math.min(bestIdx, 15);
    await this._r820tWriteReg(0x05, (lnaGain & 0x0F) | 0x10);

    // Set mixer gain
    const mixerGain = Math.min(Math.floor(bestIdx / 2), 15);
    await this._r820tWriteReg(0x07, (mixerGain & 0x0F) | 0x10);
  }

  /**
   * Read IQ samples from the device.
   * Returns Float32Array of interleaved I/Q pairs, length = numSamples * 2.
   */
  async readSamples(numSamples) {
    if (!this.device || !this.isOpen) {
      throw new Error('Device not open');
    }

    const bytesNeeded = numSamples * 2;  // 8-bit I + 8-bit Q per sample
    const blockSize = 16384;             // USB bulk transfer block size
    const totalBytes = Math.ceil(bytesNeeded / blockSize) * blockSize;

    let buffer = new Uint8Array(totalBytes);
    let offset = 0;

    while (offset < totalBytes) {
      const chunkSize = Math.min(blockSize, totalBytes - offset);
      try {
        const result = await this.device.transferIn(1, chunkSize);
        const data = new Uint8Array(result.data.buffer);
        buffer.set(data, offset);
        offset += data.length;
      } catch (e) {
        console.error('[WebUSB-RTL-SDR] Read error:', e);
        break;
      }
    }

    // Convert unsigned 8-bit to float [-1, 1]
    const iq = new Float32Array(numSamples * 2);
    for (let i = 0; i < numSamples * 2; i++) {
      iq[i] = (buffer[i] - 127.5) / 127.5;
    }

    return iq;
  }

  /**
   * Read samples and return as Complex64 (interleaved re/im Float32).
   * Suitable for direct FFT input.
   */
  async readSamplesComplex(numSamples) {
    const raw = await this.readSamples(numSamples);
    // raw is already interleaved I/Q float pairs
    return raw;
  }

  /**
   * Get list of supported gains (in dB).
   */
  getGains() {
    return [0, 0.9, 1.3, 4.0, 7.7, 8.7, 10.0, 11.5, 15.0, 17.4,
            19.7, 23.8, 28.0, 34.0, 38.9, 43.0, 44.2, 44.8, 48.0, 49.6];
  }

  // ---- RTL2832U demod internals ----

  async _ctrlTransferOut(value, index, data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: 0,
      value: value,
      index: index,
    }, buf);
  }

  async _ctrlTransferIn(value, index, length) {
    const result = await this.device.controlTransferIn({
      requestType: 'vendor',
      recipient: 'device',
      request: 0,
      value: value,
      index: index,
    }, length);
    return new Uint8Array(result.data.buffer);
  }

  async _writeReg(block, addr, val, len = 1) {
    const index = (block << 8) | 0x10;
    const data = new Uint8Array(len);
    if (len === 1) {
      data[0] = val & 0xFF;
    } else if (len === 2) {
      data[0] = (val >> 8) & 0xFF;
      data[1] = val & 0xFF;
    }
    await this._ctrlTransferOut(addr, index, data);
  }

  async _readReg(block, addr, len = 1) {
    const index = (block << 8);
    const data = await this._ctrlTransferIn(addr, index, len);
    if (len === 1) return data[0];
    return (data[0] << 8) | data[1];
  }

  async _demodWriteReg(page, addr, val) {
    const realAddr = (addr << 8) | 0x20;
    await this._writeReg(page, realAddr, val);
    // Read demod register to confirm write (required by RTL2832U)
    await this._readDemodReg(page, 0x01);
  }

  async _readDemodReg(page, addr) {
    const realAddr = (addr << 8) | 0x20;
    return await this._readReg(page, realAddr);
  }

  async _initDemod() {
    // Power on demod
    await this._writeReg(0, 0x0008, 0x4D, 1); // sys: enable ADC
    await this._writeReg(0, 0x0009, 0xCD, 1); // sys: enable demod clock

    // Disable PLL
    await this._demodWriteReg(1, 0x01, 0x14);
    // Reset demod
    await this._demodWriteReg(1, 0x01, 0x10);

    // Disable ZIF mode
    await this._demodWriteReg(1, 0x15, 0x00);
    // Enable I/Q output
    await this._demodWriteReg(1, 0x16, 0x00);

    // Initialize FIR
    await this._demodWriteReg(1, 0x19, 0x25); // manual gain
    await this._demodWriteReg(1, 0x1A, 0x00); // no spectrum inversion

    // Enable I2C repeater for tuner access
    await this._setI2CRepeater(true);

    console.log('[WebUSB-RTL-SDR] Demodulator initialized');
  }

  async _setI2CRepeater(on) {
    const val = on ? 0x18 : 0x10;
    await this._demodWriteReg(1, 0x01, val);
  }

  async _resetEndpoint() {
    await this._writeReg(0, 0x0009, 0xC0, 1);  // reset EPA
    await this._writeReg(0, 0x0009, 0xCD, 1);  // release EPA reset
  }

  async _setIfFreq(freq) {
    const ifFreqScaled = Math.round((-freq * Math.pow(2, 22)) / this._xtalFreq);
    const val = ifFreqScaled & 0x3FFFFF;
    await this._demodWriteReg(1, 0x19, (val >> 16) & 0x3F);
    await this._demodWriteReg(1, 0x1A, (val >> 8) & 0xFF);
    await this._demodWriteReg(1, 0x1B, val & 0xFF);
  }

  // ---- R820T tuner internals ----

  async _initTuner() {
    await this._setI2CRepeater(true);

    // Check tuner presence
    try {
      const val = await this._i2cRead(R820T_I2C_ADDR, 1);
      if (val[0] === R820T_CHECK_VAL) {
        this.tunerType = 'R820T';
      } else {
        this.tunerType = 'R820T2';
      }
      console.log(`[WebUSB-RTL-SDR] Detected tuner: ${this.tunerType}`);
    } catch (e) {
      console.warn('[WebUSB-RTL-SDR] Could not detect tuner, assuming R820T');
      this.tunerType = 'R820T';
    }

    // Write initial register values
    for (let i = 0; i < R820T_INIT_REGS.length; i++) {
      this._r820tRegs[i + 5] = R820T_INIT_REGS[i];
      await this._r820tWriteRegDirect(i + 5, R820T_INIT_REGS[i]);
    }

    // Set clock output on
    await this._r820tWriteReg(0x06, 0x32);
    // LNA top
    await this._r820tWriteReg(0x1D, 0x00);
    // Mixer top
    await this._r820tWriteReg(0x1C, 0x54);

    await this._setI2CRepeater(false);
    console.log('[WebUSB-RTL-SDR] Tuner initialized');
  }

  async _i2cWrite(addr, data) {
    const index = (0x0600) | 0x10;
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: 0,
      value: addr,
      index: index,
    }, buf);
  }

  async _i2cRead(addr, len) {
    const index = 0x0600;
    const result = await this.device.controlTransferIn({
      requestType: 'vendor',
      recipient: 'device',
      request: 0,
      value: addr,
      index: index,
    }, len);
    return new Uint8Array(result.data.buffer);
  }

  async _r820tWriteRegDirect(reg, val) {
    await this._setI2CRepeater(true);
    await this._i2cWrite(R820T_I2C_ADDR, [reg, val]);
  }

  async _r820tWriteReg(reg, val) {
    this._r820tRegs[reg] = val;
    await this._setI2CRepeater(true);
    await this._i2cWrite(R820T_I2C_ADDR, [reg, val]);
  }

  async _r820tWriteRegMask(reg, val, mask) {
    const old = this._r820tRegs[reg] || 0;
    const newVal = (old & ~mask) | (val & mask);
    await this._r820tWriteReg(reg, newVal);
  }

  async _r820tSetFreq(freq) {
    await this._setI2CRepeater(true);

    // Calculate divider
    const loFreq = freq;
    let mixDiv = 2;
    let divNum = 0;

    while (mixDiv <= 64) {
      if ((loFreq * mixDiv) >= 1770e6) break;
      mixDiv *= 2;
      divNum++;
    }

    // Set div_num
    await this._r820tWriteRegMask(0x10, (divNum << 5), 0xE0);

    // Calculate VCO frequency
    const vcoFreq = loFreq * mixDiv;
    const nint = Math.floor(vcoFreq / (2 * this._xtalFreq));
    const vcoFrac = vcoFreq - 2 * this._xtalFreq * nint;

    // Nint
    if (nint > 127) {
      // Use Nint / 4
      await this._r820tWriteRegMask(0x14, 0x10, 0x10);
      const ni = Math.floor(nint / 4);
      await this._r820tWriteReg(0x14, (ni & 0xFF) | 0x10);
    } else {
      await this._r820tWriteReg(0x14, nint & 0xFF);
    }

    // SDM (sigma-delta modulator fractional part)
    const sdm = Math.round((vcoFrac * 65536) / (2 * this._xtalFreq));
    await this._r820tWriteReg(0x12, (sdm >> 8) & 0xFF);
    await this._r820tWriteReg(0x13, sdm & 0xFF);

    // PLL lock check — small delay
    await this._sleep(10);

    await this._setI2CRepeater(false);
  }

  async _r820tSetBandwidth(rate) {
    await this._setI2CRepeater(true);

    // Select IF filter bandwidth based on sample rate
    let filterBw;
    if (rate < 300e3) filterBw = 0x0F;       // narrowest
    else if (rate < 600e3) filterBw = 0x0E;
    else if (rate < 1e6) filterBw = 0x0D;
    else if (rate < 1.5e6) filterBw = 0x0A;
    else if (rate < 2e6) filterBw = 0x08;
    else filterBw = 0x04;                     // widest

    await this._r820tWriteRegMask(0x0A, filterBw, 0x0F);
    await this._setI2CRepeater(false);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}


/**
 * WebUSB Spectrum Analyzer
 *
 * High-level wrapper that provides the same streaming interface as the
 * Python WebSocket backend, but runs entirely in the browser.
 */
class WebUSBSpectrumAnalyzer {
  constructor() {
    this.sdr = new WebUSBRtlSDR();
    this.fftSize = 1024;
    this.running = false;
    this.onSpectrum = null;  // callback(data)

    // Averaging
    this.avgBuffer = null;
    this.avgAlpha = 0.3;
    this.peakHold = null;

    // Window function
    this._updateWindow();
  }

  _updateWindow() {
    // Blackman-Harris window
    const N = this.fftSize;
    this._window = new Float32Array(N);
    const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
    for (let n = 0; n < N; n++) {
      this._window[n] = a0
        - a1 * Math.cos(2 * Math.PI * n / (N - 1))
        + a2 * Math.cos(4 * Math.PI * n / (N - 1))
        - a3 * Math.cos(6 * Math.PI * n / (N - 1));
    }
  }

  async open() {
    await this.sdr.open();
  }

  async close() {
    this.running = false;
    await this.sdr.close();
  }

  setCenterFreq(freqMHz) {
    this.sdr.setCenterFreq(freqMHz * 1e6);
  }

  setSampleRate(rateMHz) {
    this.sdr.setSampleRate(rateMHz * 1e6);
  }

  setGain(gain) {
    this.sdr.setGain(gain);
  }

  setFFTSize(size) {
    this.fftSize = size;
    this._updateWindow();
    this.avgBuffer = null;
    this.peakHold = null;
  }

  resetPeakHold() {
    this.peakHold = null;
  }

  /**
   * Start the acquisition loop.
   * Calls this.onSpectrum(data) on each frame.
   */
  async start(fps = 20) {
    this.running = true;
    const interval = 1000 / fps;

    while (this.running) {
      const t0 = performance.now();
      try {
        const iq = await this.sdr.readSamples(this.fftSize);
        const result = this._processFFT(iq);
        if (this.onSpectrum) {
          this.onSpectrum(result);
        }
      } catch (e) {
        console.error('[WebUSB Analyzer] Read error:', e);
      }
      const elapsed = performance.now() - t0;
      if (elapsed < interval) {
        await new Promise(r => setTimeout(r, interval - elapsed));
      }
    }
  }

  /**
   * Process IQ data: apply window, FFT, compute PSD.
   */
  _processFFT(iq) {
    const N = this.fftSize;

    // Separate I and Q, apply window
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = iq[i * 2] * this._window[i];
      im[i] = iq[i * 2 + 1] * this._window[i];
    }

    // In-place FFT (Cooley-Tukey radix-2 DIT)
    this._fft(re, im);

    // FFT shift (swap halves to put DC in center)
    const half = N >> 1;
    for (let i = 0; i < half; i++) {
      [re[i], re[i + half]] = [re[i + half], re[i]];
      [im[i], im[i + half]] = [im[i + half], im[i]];
    }

    // Magnitude in dB
    const live = new Float32Array(N);
    const log10N = 10 * Math.log10(N);
    for (let i = 0; i < N; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      live[i] = 20 * Math.log10(Math.max(mag, 1e-15)) - log10N;
    }

    // Exponential moving average
    if (!this.avgBuffer || this.avgBuffer.length !== N) {
      this.avgBuffer = live.slice();
    } else {
      const a = this.avgAlpha;
      const b = 1 - a;
      for (let i = 0; i < N; i++) {
        this.avgBuffer[i] = a * live[i] + b * this.avgBuffer[i];
      }
    }

    // Peak hold
    if (!this.peakHold || this.peakHold.length !== N) {
      this.peakHold = live.slice();
    } else {
      for (let i = 0; i < N; i++) {
        if (live[i] > this.peakHold[i]) this.peakHold[i] = live[i];
      }
    }

    // Frequency axis
    const fc = this.sdr.centerFreq;
    const fs = this.sdr.sampleRate;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      freqs[i] = (fc - fs / 2 + (i / N) * fs) / 1e6;
    }

    return {
      type: 'spectrum',
      freqs: Array.from(freqs),
      live: Array.from(live),
      avg: Array.from(this.avgBuffer),
      peak: Array.from(this.peakHold),
      center_freq: fc / 1e6,
      sample_rate: fs / 1e6,
      gain: this.sdr.gain,
      fft_size: N,
      bands: {
        "FCC (US)":  {start: 902.0, end: 928.0, channels: 50, power: "1W ERP"},
        "ETSI (EU)": {start: 865.6, end: 867.6, channels: 4,  power: "2W ERP"},
        "China":     {start: 920.0, end: 925.0, channels: 16, power: "2W ERP"},
        "Japan":     {start: 916.8, end: 920.4, channels: 9,  power: "250mW"},
        "Korea":     {start: 917.0, end: 923.5, channels: 13, power: "200mW"},
        "Brazil":    {start: 902.0, end: 907.5, channels: 11, power: "4W EIRP"},
        "Australia": {start: 920.0, end: 926.0, channels: 12, power: "1W EIRP"},
      },
    };
  }

  /**
   * In-place Cooley-Tukey FFT (radix-2 decimation-in-time).
   */
  _fft(re, im) {
    const N = re.length;
    if (N <= 1) return;

    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
      let k = N >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }

    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = -2 * Math.PI / len;
      const wRe = Math.cos(angle);
      const wIm = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < halfLen; k++) {
          const tRe = curRe * re[i + k + halfLen] - curIm * im[i + k + halfLen];
          const tIm = curRe * im[i + k + halfLen] + curIm * re[i + k + halfLen];
          re[i + k + halfLen] = re[i + k] - tRe;
          im[i + k + halfLen] = im[i + k] - tIm;
          re[i + k] += tRe;
          im[i + k] += tIm;
          const newCurRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = newCurRe;
        }
      }
    }
  }
}

// Export for use in index.html
window.WebUSBRtlSDR = WebUSBRtlSDR;
window.WebUSBSpectrumAnalyzer = WebUSBSpectrumAnalyzer;

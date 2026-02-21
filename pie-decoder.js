/**
 * PIE (Pulse Interval Encoding) Decoder for EPC Gen2 / Gen2v2 / Gen2X
 *
 * Decodes reader→tag (R2T) commands from raw IQ samples captured by an RTL-SDR.
 * Reader commands use strong ASK modulation easily visible in the RF envelope.
 *
 * Signal processing pipeline:
 *   Raw IQ → envelope (magnitude) → lowpass filter → adaptive threshold →
 *   binary → edge detection → PIE state machine → bits → Gen2 parser → message
 *
 * PIE state machine states:
 *   IDLE → WAIT_DELIMITER → WAIT_DATA0 → WAIT_RTCAL → DECODING_BITS →
 *   PARSE_COMMAND → IDLE
 *
 * Usage:
 *   const decoder = new PIEDecoder({
 *     sampleRate: 2400000,
 *     centerFreqMHz: 915,
 *     onMessage: (msg) => console.log(msg),
 *   });
 *   decoder.process(iqFloat32Array);
 */

// =========================================================================
// CRC tables
// =========================================================================

// CRC-5 for Gen2 Query command (polynomial x^5 + x^3 + 1 = 0x29, init 0x09)
const CRC5_PRESET = 0x09;
const CRC5_POLY   = 0x29;

function crc5(bits) {
  let crc = CRC5_PRESET;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i] & 1;
    const msb = (crc >> 4) & 1;
    crc = ((crc << 1) | b) & 0x1F;
    if (msb) crc ^= CRC5_POLY;
  }
  return crc;
}

// CRC-16 for Gen2 commands (polynomial x^16 + x^12 + x^5 + 1 = 0x1021, init 0xFFFF)
const CRC16_PRESET = 0xFFFF;
const CRC16_POLY   = 0x1021;

function crc16(bits) {
  let crc = CRC16_PRESET;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i] & 1;
    const msb = (crc >> 15) & 1;
    crc = ((crc << 1) | b) & 0xFFFF;
    if (msb) crc ^= CRC16_POLY;
  }
  return crc;
}

// =========================================================================
// Bit extraction utilities
// =========================================================================

function bitsToInt(bits, start, length) {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = (val << 1) | (bits[start + i] & 1);
  }
  return val;
}

function bitsToHex(bits, start, length) {
  const nybbles = Math.ceil(length / 4);
  let hex = '';
  for (let n = 0; n < nybbles; n++) {
    const bitOfs = start + n * 4;
    const remain = Math.min(4, length - n * 4);
    let val = 0;
    for (let i = 0; i < remain; i++) {
      val = (val << 1) | (bits[bitOfs + i] & 1);
    }
    if (remain < 4) val <<= (4 - remain);
    hex += val.toString(16).toUpperCase();
  }
  return hex;
}

/**
 * Extract EBV (Extensible Bit Vector) from bit array.
 * Each group: 1 extension bit + 7 data bits. Extension=1 means more groups follow.
 * Returns { value, bitsConsumed }.
 */
function extractEBV(bits, start) {
  let value = 0;
  let pos = start;
  let more = true;
  while (more && pos < bits.length) {
    more = bits[pos] === 1;
    pos++;
    for (let i = 0; i < 7 && pos < bits.length; i++) {
      value = (value << 1) | (bits[pos] & 1);
      pos++;
    }
  }
  return { value, bitsConsumed: pos - start };
}

// =========================================================================
// Gen2 Command Parser
// =========================================================================

const SESSION_MAP = ['S0', 'S1', 'S2', 'S3'];
const TARGET_MAP  = ['A', 'B'];
const M_MAP       = ['FM0', 'Miller2', 'Miller4', 'Miller8'];
const DR_MAP      = ['8', '64/3'];
const SEL_MAP     = ['All', 'All', '~SL', 'SL'];
const MEMBANK_MAP = ['Reserved', 'EPC', 'TID', 'User'];
const ACTION_MAP  = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];

function parseGen2Command(bits) {
  if (bits.length < 2) return null;

  // 2-bit commands
  const prefix2 = bitsToInt(bits, 0, 2);
  if (prefix2 === 0b00) return parseQueryRep(bits);
  if (prefix2 === 0b01) return parseACK(bits);

  // 4-bit commands
  if (bits.length < 4) return null;
  const prefix4 = bitsToInt(bits, 0, 4);
  if (prefix4 === 0b1000) return parseQuery(bits);
  if (prefix4 === 0b1001) return parseQueryAdjust(bits);
  if (prefix4 === 0b1010) return parseSelect(bits);
  if (prefix4 === 0b1011) return parseNAK(bits);

  // 8-bit commands
  if (bits.length < 8) return null;
  const prefix8 = bitsToInt(bits, 0, 8);

  switch (prefix8) {
    case 0b11000000: return parseReqRN(bits);
    case 0b11000001: return parseRead(bits);
    case 0b11000010: return parseWrite(bits);
    case 0b11000011: return parseKill(bits);
    case 0b11000100: return parseLock(bits);
    case 0b11000101: return parseAccess(bits);
    case 0b11000110: return parseBlockWrite(bits);
    case 0b11000111: return parseBlockErase(bits);
    // Gen2v2 security
    case 0b11010000: return parseAuthenticate(bits);
    case 0b11010001: return parseAuthComm(bits);
    case 0b11010010: return parseSecureComm(bits);
    case 0b11010100: return parseTagPrivilege(bits);
    // Gen2X (Impinj)
    case 0b11100000: return parseQueryX(bits);
    case 0b11100001: return parseQueryY(bits);
    default: break;
  }

  // Unknown command
  return {
    command: 'Unknown',
    params: { prefix: bitsToHex(bits, 0, Math.min(bits.length, 16)), totalBits: bits.length },
    crcValid: null,
  };
}

// ---- Individual command parsers ----

function parseQueryRep(bits) {
  // 00 + 2-bit session = 4 bits total
  if (bits.length < 4) return { command: 'QueryRep', params: {}, crcValid: null };
  const session = SESSION_MAP[bitsToInt(bits, 2, 2)];
  return { command: 'QueryRep', params: { session }, crcValid: null };
}

function parseACK(bits) {
  // 01 + 16-bit RN16 = 18 bits total
  if (bits.length < 18) return { command: 'ACK', params: {}, crcValid: null };
  const rn16 = bitsToHex(bits, 2, 16);
  return { command: 'ACK', params: { rn16 }, crcValid: null };
}

function parseQuery(bits) {
  // 1000 + DR(1) + M(2) + TRext(1) + Sel(2) + Session(2) + Target(1) + Q(4) + CRC5(5) = 22 bits
  if (bits.length < 22) return { command: 'Query', params: { partial: true }, crcValid: null };
  const DR      = DR_MAP[bitsToInt(bits, 4, 1)];
  const M       = M_MAP[bitsToInt(bits, 5, 2)];
  const TRext   = bits[7] === 1;
  const Sel     = SEL_MAP[bitsToInt(bits, 8, 2)];
  const session = SESSION_MAP[bitsToInt(bits, 10, 2)];
  const target  = TARGET_MAP[bitsToInt(bits, 12, 1)];
  const Q       = bitsToInt(bits, 13, 4);
  const crcBits = bits.slice(0, 17); // data bits for CRC
  const crcVal  = bitsToInt(bits, 17, 5);
  const valid   = crc5(crcBits) === crcVal;
  return {
    command: 'Query',
    params: { DR, M, TRext, Sel, session, target, Q },
    crcValid: valid,
  };
}

function parseQueryAdjust(bits) {
  // 1001 + session(2) + UpDn(3) = 9 bits
  if (bits.length < 9) return { command: 'QueryAdjust', params: {}, crcValid: null };
  const session = SESSION_MAP[bitsToInt(bits, 4, 2)];
  const upDnRaw = bitsToInt(bits, 6, 3);
  let upDn = 'unchanged';
  if (upDnRaw === 0b110) upDn = 'up';
  else if (upDnRaw === 0b011) upDn = 'down';
  return { command: 'QueryAdjust', params: { session, upDn }, crcValid: null };
}

function parseSelect(bits) {
  // 1010 + Target(3) + Action(3) + MemBank(2) + Pointer(EBV) + Length(8) + Mask(var) + Truncate(1) + CRC16(16)
  if (bits.length < 26) return { command: 'Select', params: { partial: true }, crcValid: null };
  const target  = bitsToInt(bits, 4, 3);
  const action  = ACTION_MAP[bitsToInt(bits, 7, 3)];
  const memBank = MEMBANK_MAP[bitsToInt(bits, 10, 2)];
  const ptrResult = extractEBV(bits, 12);
  const pointer = ptrResult.value;
  let pos = 12 + ptrResult.bitsConsumed;

  if (pos + 8 > bits.length) return { command: 'Select', params: { target: target <= 3 ? SESSION_MAP[target] : 'SL', action, memBank, pointer }, crcValid: null };
  const length = bitsToInt(bits, pos, 8);
  pos += 8;

  let mask = '';
  if (pos + length <= bits.length) {
    mask = bitsToHex(bits, pos, length);
    pos += length;
  }

  let truncate = false;
  if (pos < bits.length) {
    truncate = bits[pos] === 1;
    pos++;
  }

  // CRC-16 validation
  let crcValid = null;
  if (pos + 16 <= bits.length) {
    const dataBits = bits.slice(0, pos);
    const crcVal = crc16(dataBits);
    crcValid = crcVal === 0; // residue should be 0 if CRC appended
  }

  const targetStr = target <= 3 ? SESSION_MAP[target] : (target === 4 ? 'SL' : `inv(${target})`);
  return {
    command: 'Select',
    params: { target: targetStr, action, memBank, pointer, length, mask: mask || '', truncate },
    crcValid,
  };
}

function parseNAK(bits) {
  // 10110000 = 8 bits (padded or just 1011 with CRC)
  return { command: 'NAK', params: {}, crcValid: null };
}

function parseReqRN(bits) {
  // 11000000 + RN16(16) + CRC16(16) = 40 bits
  if (bits.length < 40) return { command: 'ReqRN', params: { partial: true }, crcValid: null };
  const rn16 = bitsToHex(bits, 8, 16);
  const crcVal = crc16(bits.slice(0, 24));
  const crcExpected = bitsToInt(bits, 24, 16);
  return { command: 'ReqRN', params: { rn16 }, crcValid: crcVal === crcExpected };
}

function parseRead(bits) {
  // 11000001 + MemBank(2) + WordPtr(EBV) + WordCount(8) + RN(16) + CRC16(16)
  if (bits.length < 26) return { command: 'Read', params: { partial: true }, crcValid: null };
  const memBank = MEMBANK_MAP[bitsToInt(bits, 8, 2)];
  const ptrResult = extractEBV(bits, 10);
  const wordPtr = ptrResult.value;
  let pos = 10 + ptrResult.bitsConsumed;
  let wordCount = 0;
  if (pos + 8 <= bits.length) {
    wordCount = bitsToInt(bits, pos, 8);
    pos += 8;
  }
  // Skip RN and CRC for now
  return {
    command: 'Read',
    params: { memBank, wordPtr, wordCount },
    crcValid: null,
  };
}

function parseWrite(bits) {
  // 11000010 + MemBank(2) + WordPtr(EBV) + Data(16) + RN(16) + CRC16(16)
  if (bits.length < 26) return { command: 'Write', params: { partial: true }, crcValid: null };
  const memBank = MEMBANK_MAP[bitsToInt(bits, 8, 2)];
  const ptrResult = extractEBV(bits, 10);
  const wordPtr = ptrResult.value;
  let pos = 10 + ptrResult.bitsConsumed;
  let data = '';
  if (pos + 16 <= bits.length) {
    data = bitsToHex(bits, pos, 16);
    pos += 16;
  }
  return {
    command: 'Write',
    params: { memBank, wordPtr, data },
    crcValid: null,
  };
}

function parseKill(bits) {
  // 11000011 + Password(16) + RN(16) + CRC16(16) = 56 bits
  if (bits.length < 40) return { command: 'Kill', params: { partial: true }, crcValid: null };
  const password = bitsToHex(bits, 8, 16);
  return { command: 'Kill', params: { password }, crcValid: null };
}

function parseLock(bits) {
  // 11000100 + Payload(20) + RN(16) + CRC16(16) = 60 bits
  if (bits.length < 28) return { command: 'Lock', params: { partial: true }, crcValid: null };
  const payload = bitsToHex(bits, 8, 20);
  return { command: 'Lock', params: { payload }, crcValid: null };
}

function parseAccess(bits) {
  // 11000101 + Password(16) + RN(16) + CRC16(16) = 56 bits
  if (bits.length < 40) return { command: 'Access', params: { partial: true }, crcValid: null };
  const password = bitsToHex(bits, 8, 16);
  return { command: 'Access', params: { password }, crcValid: null };
}

function parseBlockWrite(bits) {
  // 11000110 + MemBank(2) + WordPtr(EBV) + WordCount(8) + Data(N*16) + RN(16) + CRC16(16)
  if (bits.length < 26) return { command: 'BlockWrite', params: { partial: true }, crcValid: null };
  const memBank = MEMBANK_MAP[bitsToInt(bits, 8, 2)];
  const ptrResult = extractEBV(bits, 10);
  const wordPtr = ptrResult.value;
  let pos = 10 + ptrResult.bitsConsumed;
  let wordCount = 0;
  let data = '';
  if (pos + 8 <= bits.length) {
    wordCount = bitsToInt(bits, pos, 8);
    pos += 8;
  }
  const dataBits = wordCount * 16;
  if (pos + dataBits <= bits.length) {
    data = bitsToHex(bits, pos, dataBits);
  }
  return {
    command: 'BlockWrite',
    params: { memBank, wordPtr, wordCount, data },
    crcValid: null,
  };
}

function parseBlockErase(bits) {
  // 11000111 + MemBank(2) + WordPtr(EBV) + WordCount(8) + RN(16) + CRC16(16)
  if (bits.length < 26) return { command: 'BlockErase', params: { partial: true }, crcValid: null };
  const memBank = MEMBANK_MAP[bitsToInt(bits, 8, 2)];
  const ptrResult = extractEBV(bits, 10);
  const wordPtr = ptrResult.value;
  let pos = 10 + ptrResult.bitsConsumed;
  let wordCount = 0;
  if (pos + 8 <= bits.length) {
    wordCount = bitsToInt(bits, pos, 8);
  }
  return {
    command: 'BlockErase',
    params: { memBank, wordPtr, wordCount },
    crcValid: null,
  };
}

// ---- Gen2v2 Security Commands ----

function parseAuthenticate(bits) {
  // 11010000 + CSI(2) + variable length
  if (bits.length < 10) return { command: 'Authenticate', params: { partial: true }, crcValid: null };
  const csi = bitsToInt(bits, 8, 2);
  const csiStr = csi === 0 ? 'Crypto Suite 0' : csi === 1 ? 'AES-128' : `CSI(${csi})`;
  return {
    command: 'Authenticate',
    params: { CSI: csiStr, rawBits: bitsToHex(bits, 10, Math.min(bits.length - 10, 128)) },
    crcValid: null,
  };
}

function parseAuthComm(bits) {
  // 11010001 + variable
  return {
    command: 'AuthComm',
    params: { rawBits: bits.length > 8 ? bitsToHex(bits, 8, Math.min(bits.length - 8, 128)) : '' },
    crcValid: null,
  };
}

function parseSecureComm(bits) {
  // 11010010 + variable
  return {
    command: 'SecureComm',
    params: { rawBits: bits.length > 8 ? bitsToHex(bits, 8, Math.min(bits.length - 8, 128)) : '' },
    crcValid: null,
  };
}

function parseTagPrivilege(bits) {
  // 11010100 + variable
  return {
    command: 'TagPrivilege',
    params: { rawBits: bits.length > 8 ? bitsToHex(bits, 8, Math.min(bits.length - 8, 128)) : '' },
    crcValid: null,
  };
}

// ---- Gen2X (Impinj) ----

function parseQueryX(bits) {
  // 11100000 + variable
  return {
    command: 'QueryX',
    params: { rawBits: bits.length > 8 ? bitsToHex(bits, 8, Math.min(bits.length - 8, 128)) : '' },
    crcValid: null,
  };
}

function parseQueryY(bits) {
  // 11100001 + variable
  return {
    command: 'QueryY',
    params: { rawBits: bits.length > 8 ? bitsToHex(bits, 8, Math.min(bits.length - 8, 128)) : '' },
    crcValid: null,
  };
}


// =========================================================================
// PIE Decoder — Signal Processing + State Machine
// =========================================================================

const PIE_STATE = {
  IDLE:           0,
  WAIT_DELIMITER: 1,
  WAIT_DATA0:     2,
  WAIT_RTCAL:     3,
  DECODING_BITS:  4,
  PARSE_COMMAND:  5,
};

class PIEDecoder {
  /**
   * @param {Object} opts
   * @param {number} opts.sampleRate   - IQ sample rate in Hz (e.g. 2400000)
   * @param {number} opts.centerFreqMHz - Center frequency in MHz (e.g. 915)
   * @param {function} opts.onMessage  - Callback for decoded messages
   */
  constructor({ sampleRate = 2400000, centerFreqMHz = 915, onMessage = null } = {}) {
    this.sampleRate = sampleRate;
    this.centerFreqMHz = centerFreqMHz;
    this.onMessage = onMessage;

    // ---- Lowpass filter ----
    // Simple single-pole IIR, cutoff ~100 kHz for 2.4 MSPS
    this._lpAlpha = Math.min(1.0, 2 * Math.PI * 100000 / sampleRate);
    this._lpState = 0;

    // ---- Adaptive threshold ----
    // EMA of high and low envelope levels
    this._emaHigh = 0;
    this._emaLow = 0;
    this._emaAlpha = 0.002; // slow adaptation
    this._threshold = 0;
    this._thresholdInitialized = false;

    // ---- Edge detection ----
    this._prevBinary = 0;
    this._globalSampleOffset = 0;
    this._lastEdgeOffset = 0;

    // ---- PIE state machine ----
    this._state = PIE_STATE.IDLE;
    this._tari = 0;          // Reference interval (Data-0 duration) in samples
    this._rtcal = 0;         // RTcal duration in samples
    this._pivot = 0;         // Decision threshold = RTcal / 2
    this._bits = [];          // Collected bits for current command
    this._lastHighDuration = 0;  // Duration of last high period
    this._lastLowDuration = 0;   // Duration of last low period
    this._symbolStart = 0;   // Start offset of current symbol
    this._cwTimeout = 0;     // CW gap timeout in samples (3 × RTcal)

    // ---- Timing limits in μs ----
    this._delimiterMinUs = 8;
    this._delimiterMaxUs = 19;
    this._tariMinUs = 6.25;
    this._tariMaxUs = 25;

    // ---- Round tracking ----
    this._roundId = 0;
    this._pendingSelectRoundId = null;

    // ---- Carry-over buffer for filter continuity ----
    this._carryOver = null;
    this._carryOverLen = 64;

    // ---- Statistics ----
    this.stats = {
      preamblesSeen: 0,
      commandsDecoded: 0,
      crcErrors: 0,
    };
  }

  /**
   * Update center frequency (for message metadata).
   */
  setCenterFreq(mhz) {
    this.centerFreqMHz = mhz;
  }

  /**
   * Reset the decoder state machine.
   */
  reset() {
    this._state = PIE_STATE.IDLE;
    this._bits = [];
    this._lpState = 0;
    this._prevBinary = 0;
    this._emaHigh = 0;
    this._emaLow = 0;
    this._thresholdInitialized = false;
    this._carryOver = null;
    this._globalSampleOffset = 0;
  }

  /**
   * Feed raw IQ samples (Float32Array of interleaved I/Q pairs).
   * This is the main entry point — call it repeatedly with chunks from the SDR.
   */
  process(iqFloat32Array) {
    const len = iqFloat32Array.length / 2; // number of complex samples
    if (len === 0) return;

    // Step 1: Compute envelope (magnitude)
    const envelope = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const re = iqFloat32Array[i * 2];
      const im = iqFloat32Array[i * 2 + 1];
      envelope[i] = Math.sqrt(re * re + im * im);
    }

    // Step 2: Lowpass filter the envelope
    const filtered = new Float32Array(len);
    let lp = this._lpState;
    const a = this._lpAlpha;
    for (let i = 0; i < len; i++) {
      lp += a * (envelope[i] - lp);
      filtered[i] = lp;
    }
    this._lpState = lp;

    // Step 3: Adaptive threshold
    this._updateThreshold(filtered);

    // Step 4: Binary conversion + edge detection + state machine
    for (let i = 0; i < len; i++) {
      const binary = filtered[i] >= this._threshold ? 1 : 0;
      const globalPos = this._globalSampleOffset + i;

      if (binary !== this._prevBinary) {
        // Edge detected
        const edgeDuration = globalPos - this._lastEdgeOffset;

        if (binary === 0) {
          // Falling edge (high → low)
          this._lastHighDuration = edgeDuration;
          this._onFallingEdge(globalPos, edgeDuration);
        } else {
          // Rising edge (low → high)
          this._lastLowDuration = edgeDuration;
          this._onRisingEdge(globalPos, edgeDuration);
        }

        this._lastEdgeOffset = globalPos;
      }

      // Check CW timeout while decoding
      if (this._state === PIE_STATE.DECODING_BITS && binary === 1) {
        const cwDuration = globalPos - this._lastEdgeOffset;
        if (this._cwTimeout > 0 && cwDuration > this._cwTimeout) {
          this._finishCommand();
        }
      }

      this._prevBinary = binary;
    }

    this._globalSampleOffset += len;
  }

  // ---- Internal: Adaptive threshold ----

  _updateThreshold(filtered) {
    const emaA = this._emaAlpha;
    for (let i = 0; i < filtered.length; i++) {
      const v = filtered[i];
      if (!this._thresholdInitialized) {
        this._emaHigh = v;
        this._emaLow = v;
        this._thresholdInitialized = true;
      }
      if (v > this._emaHigh) {
        this._emaHigh += emaA * (v - this._emaHigh);
      } else {
        this._emaHigh -= emaA * 0.1 * (this._emaHigh - v);
      }
      if (v < this._emaLow) {
        this._emaLow += emaA * (v - this._emaLow);
      } else {
        this._emaLow += emaA * 0.1 * (v - this._emaLow);
      }
    }
    this._threshold = (this._emaHigh + this._emaLow) / 2;
  }

  // ---- Internal: Edge handlers ----

  _samplesToUs(samples) {
    return (samples / this.sampleRate) * 1e6;
  }

  _onFallingEdge(pos, highDuration) {
    // Falling edge = start of a low period (potential delimiter or data symbol gap)
    switch (this._state) {
      case PIE_STATE.IDLE:
        // Potential start of preamble — look for delimiter on next rising edge
        this._state = PIE_STATE.WAIT_DELIMITER;
        this._symbolStart = pos;
        break;

      case PIE_STATE.DECODING_BITS: {
        // In data: falling edge ends a full symbol
        // Symbol duration = time from last falling edge to this falling edge
        // (We measure from symbolStart which is the last falling edge)
        const symbolDuration = pos - this._symbolStart;
        if (this._pivot > 0) {
          this._bits.push(symbolDuration >= this._pivot ? 1 : 0);
        }
        this._symbolStart = pos;
        break;
      }
    }
  }

  _onRisingEdge(pos, lowDuration) {
    const lowUs = this._samplesToUs(lowDuration);

    switch (this._state) {
      case PIE_STATE.WAIT_DELIMITER:
        // Check if low pulse is a valid delimiter (~12.5 μs, range 8–19 μs)
        if (lowUs >= this._delimiterMinUs && lowUs <= this._delimiterMaxUs) {
          // Valid delimiter found
          this._state = PIE_STATE.WAIT_DATA0;
          this._symbolStart = this._lastEdgeOffset; // start of the symbol containing data-0
        } else {
          // Not a valid delimiter — back to idle
          this._state = PIE_STATE.IDLE;
        }
        break;

      case PIE_STATE.WAIT_DATA0:
        // This low duration is part of Data-0 reference; wait for next falling edge
        // Actually, we need the FULL symbol. Data-0 = Tari = one full symbol period.
        // We'll measure from the delimiter's rising edge to the next falling edge (high period)
        // then to the next rising edge (low period) = full symbol = Tari.
        // But we need the falling edge first. Let the falling handler transition us.
        // On second thought: The falling edge after delimiter starts Data-0.
        // Then the next falling edge ends Data-0 and starts RTcal.
        // Let's restructure: after delimiter (rising edge), the next falling edge
        // marks the start of Data-0 measurement.
        // Actually, in PIE encoding, the preamble is:
        //   delimiter → data-0 → RTcal → [TRcal]
        // where data-0 and RTcal are full symbols measured falling-to-falling.
        // The delimiter IS the low period we just checked. After delimiter,
        // the signal goes high (we're at the rising edge now).
        // Next falling edge = end of first high, start of data-0's low phase.
        // We need falling-edge to falling-edge for Tari.
        break;

      case PIE_STATE.DECODING_BITS:
        // Rising edge within data — no action needed for PIE
        // (PIE measures falling-to-falling)
        break;
    }
  }

  /**
   * Override _onFallingEdge for preamble measurement.
   * We need to restructure the state machine to properly measure
   * Data-0 (Tari) and RTcal as falling-to-falling durations.
   */

  // Re-implementing with cleaner falling-edge-driven PIE measurement:

  _onFallingEdge(pos, highDuration) {
    switch (this._state) {
      case PIE_STATE.IDLE:
        // Any falling edge: start looking for delimiter
        this._state = PIE_STATE.WAIT_DELIMITER;
        this._symbolStart = pos;
        break;

      case PIE_STATE.WAIT_DELIMITER:
        // We're in a low period; the rising edge handler checks delimiter width.
        // If we get another falling edge before a valid delimiter, restart.
        this._symbolStart = pos;
        break;

      case PIE_STATE.WAIT_DATA0:
        // First falling edge after delimiter rising edge:
        // This marks the boundary. The NEXT falling edge will complete Data-0.
        this._state = PIE_STATE.WAIT_RTCAL;
        this._symbolStart = pos;
        break;

      case PIE_STATE.WAIT_RTCAL: {
        // Second falling edge after delimiter:
        // If this is the Data-0 reference, measure Tari
        const duration = pos - this._symbolStart;
        const durationUs = this._samplesToUs(duration);
        if (this._tari === 0) {
          // This is Data-0 = Tari
          if (durationUs >= this._tariMinUs && durationUs <= this._tariMaxUs) {
            this._tari = duration;
            this._symbolStart = pos;
            // Stay in WAIT_RTCAL to measure RTcal next
          } else {
            // Invalid Tari — back to idle
            this._resetPreamble();
          }
        } else {
          // This is RTcal
          const tariUs = this._samplesToUs(this._tari);
          const rtcalUs = this._samplesToUs(duration);
          // RTcal should be > 2.5 × Tari and < 3 × 4 × Tari (generous range)
          if (rtcalUs > tariUs * 1.5 && rtcalUs < tariUs * 8) {
            this._rtcal = duration;
            this._pivot = duration / 2;
            this._cwTimeout = this._rtcal * 3; // CW gap timeout
            this._bits = [];
            this._symbolStart = pos;
            this._state = PIE_STATE.DECODING_BITS;
            this.stats.preamblesSeen++;
          } else {
            this._resetPreamble();
          }
        }
        break;
      }

      case PIE_STATE.DECODING_BITS: {
        // Each falling edge marks the end of a symbol
        const symbolDuration = pos - this._symbolStart;
        if (this._pivot > 0) {
          // Short symbol (< pivot) = 0, long symbol (>= pivot) = 1
          this._bits.push(symbolDuration >= this._pivot ? 1 : 0);
        }
        this._symbolStart = pos;

        // Safety: bail if we've collected too many bits (malformed)
        if (this._bits.length > 512) {
          this._finishCommand();
        }
        break;
      }
    }
  }

  // Override rising edge handler too for the cleaner approach
  _onRisingEdge(pos, lowDuration) {
    const lowUs = this._samplesToUs(lowDuration);

    switch (this._state) {
      case PIE_STATE.WAIT_DELIMITER:
        // Check if this low pulse is a valid delimiter
        if (lowUs >= this._delimiterMinUs && lowUs <= this._delimiterMaxUs) {
          this._state = PIE_STATE.WAIT_DATA0;
        } else if (lowUs > this._delimiterMaxUs) {
          // Too long — might be noise, reset
          this._state = PIE_STATE.IDLE;
        }
        // If too short, stay in WAIT_DELIMITER
        break;

      case PIE_STATE.WAIT_DATA0:
        // Rising edge within Data-0 area — just wait for falling edges
        break;

      case PIE_STATE.WAIT_RTCAL:
        // Rising edge during RTcal measurement — no action
        break;

      case PIE_STATE.DECODING_BITS:
        // Rising edge in data — check if this is a valid low period within a symbol
        // In PIE, the low period within a symbol should be relatively short (PW)
        // If it's excessively long, it might be an inter-command gap
        break;
    }
  }

  _resetPreamble() {
    this._state = PIE_STATE.IDLE;
    this._tari = 0;
    this._rtcal = 0;
    this._pivot = 0;
    this._bits = [];
  }

  _finishCommand() {
    if (this._bits.length >= 2) {
      const result = parseGen2Command(this._bits);
      if (result) {
        this._emitMessage(result);
      }
    }
    this._resetPreamble();
  }

  _emitMessage(parsed) {
    const isNewRound = ['Query', 'QueryX', 'QueryY'].includes(parsed.command);
    const isSelect = parsed.command === 'Select';

    if (isNewRound) {
      this._roundId++;
      // If a Select preceded this Query, retroactively assign it this round
      if (this._pendingSelectRoundId !== null) {
        this._pendingSelectRoundId = null;
      }
    }

    if (isSelect && !isNewRound) {
      // Select might precede a Query — track it
      this._pendingSelectRoundId = this._roundId + 1;
    }

    const roundId = isSelect && this._pendingSelectRoundId !== null
      ? this._pendingSelectRoundId
      : this._roundId;

    const msg = {
      direction: 'R2T',
      command: parsed.command,
      roundId,
      freq: this.centerFreqMHz,
      params: parsed.params,
      tagEpc: null,
      timestamp: performance.now(),
      crcValid: parsed.crcValid,
    };

    this.stats.commandsDecoded++;
    if (parsed.crcValid === false) this.stats.crcErrors++;

    if (this.onMessage) {
      this.onMessage(msg);
    }
  }
}

// =========================================================================
// Export
// =========================================================================
window.PIEDecoder = PIEDecoder;

/**
 * Mock RFID Protocol Decode Generator
 * Extracted from index.html — generates simulated EPC Gen2/Gen2v2/Gen2X protocol messages.
 */

import type { DecodeMessage } from '../stores/decodeStore'

const MOCK_TAG_POOL = [
  { epc: 'E200 3411 B802 0115 2690 2154', pc: '3000', tid: 'E200 3411 B802 0115', killPwd: '00000000', accessPwd: '00000000', user: '0000 0000 0000 0000', mfg: 'Impinj Monza R6' },
  { epc: 'E200 6811 9504 0074 2780 4F21', pc: '3000', tid: 'E200 6811 9504 0074', killPwd: '00000000', accessPwd: '00000000', user: '0000 0000 0000 0000', mfg: 'Impinj Monza R6-P' },
  { epc: '3034 0242 8C2A 0052 0000 040C', pc: '3000', tid: 'E001 1302 B014 2210', killPwd: '00000000', accessPwd: 'DEADBEEF', user: 'CAFE BABE 1234 5678', mfg: 'NXP UCODE 8' },
  { epc: '3034 0242 8C2A 0052 0000 040D', pc: '3000', tid: 'E001 1302 B014 2211', killPwd: '00000000', accessPwd: 'A5A5A5A5', user: 'DEAD BEEF 0000 0000', mfg: 'NXP UCODE 8m' },
  { epc: 'E280 1160 2000 0209 6496 2436', pc: '3400', tid: 'E280 1160 2000 0209', killPwd: '00000000', accessPwd: '00000000', user: '0000 0000 0000 0000', mfg: 'Impinj M730' },
  { epc: 'E280 1194 2000 0071 2F18 1A56', pc: '3400', tid: 'E280 1194 2000 0071', killPwd: '00000000', accessPwd: '12345678', user: '4865 6C6C 6F21 0000', mfg: 'Impinj M750' },
  { epc: 'AD00 0000 0000 0000 0000 0001', pc: '3000', tid: 'AD10 0010 0000 0001', killPwd: 'FFFFFFFF', accessPwd: 'FFFFFFFF', user: '5465 7374 4461 7461', mfg: 'Impinj M800' },
  { epc: 'AD00 0000 0000 0000 0000 0002', pc: '3000', tid: 'AD10 0010 0000 0002', killPwd: '00000000', accessPwd: '00000000', user: '576F 726C 6421 0000', mfg: 'Impinj M800' },
]

const FHSS_CHANNELS = [
  902.75, 904.25, 905.75, 907.25, 908.75, 910.25,
  911.75, 913.25, 915.00, 916.50, 918.00, 919.50,
  921.00, 922.50, 924.00, 925.50, 927.00,
]

function rHex(len: number) {
  let s = ''
  for (let i = 0; i < len; i++) s += ((Math.random() * 16) | 0).toString(16).toUpperCase()
  return s
}
function rn16() { return rHex(4) }
function pickCh() { return FHSS_CHANNELS[(Math.random() * FHSS_CHANNELS.length) | 0] }
function pickTags(n: number) {
  const s = [...MOCK_TAG_POOL].sort(() => Math.random() - 0.5)
  return s.slice(0, Math.min(n, s.length))
}
function wPick<T>(items: T[], weights: number[]): T {
  const t = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * t
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i] }
  return items[items.length - 1]
}

type PartialMsg = Omit<DecodeMessage, 'id' | 'timestamp'>

export class MockRFIDDecoder {
  private _enabled = true
  private _paused = false
  private _mode = 'mixed'
  private _roundId = 0
  private _roundCounter = 0
  private _lastRoundTime = 0
  private _roundInterval = 150
  private _pendingMessages: { fireAt: number; msg: PartialMsg }[] = []
  private _onMessage: (msg: PartialMsg) => void

  constructor(onMessage: (msg: PartialMsg) => void) {
    this._onMessage = onMessage
  }

  get enabled() { return this._enabled }
  set enabled(v: boolean) { this._enabled = v }
  get paused() { return this._paused }
  set paused(v: boolean) { this._paused = v }
  get mode() { return this._mode }
  set mode(v: string) { this._mode = v }

  tick() {
    if (!this._enabled) return
    this._processPending()
    const now = performance.now()
    if (now - this._lastRoundTime > this._roundInterval && this._pendingMessages.length === 0) {
      this._lastRoundTime = now
      this._roundInterval = 100 + Math.random() * 150
      if (this._mode === 'reader-only') this._genReaderOnly()
      else if (this._mode === 'inventory') this._genInventory()
      else if (this._mode === 'access') this._genAccess()
      else if (this._mode === 'security') this._genSecurity()
      else if (this._mode === 'gen2x') this._genGen2X()
      else {
        const r = this._roundCounter
        if (r > 0 && r % (8 + ((Math.random() * 4) | 0)) === 0) this._genGen2X()
        else if (r > 0 && r % (10 + ((Math.random() * 5) | 0)) === 0) this._genSecurity()
        else if (r > 0 && r % (5 + ((Math.random() * 3) | 0)) === 0) this._genAccess()
        else this._genInventory()
      }
    }
  }

  clear() {
    this._roundId = 0
    this._roundCounter = 0
    this._pendingMessages = []
  }

  private _schedule(delayMs: number, msg: PartialMsg) {
    this._pendingMessages.push({ fireAt: performance.now() + delayMs, msg })
  }

  private _push(msg: PartialMsg & { timestamp?: number }) {
    if (!this._enabled) return
    this._onMessage(msg)
  }

  private _processPending() {
    const now = performance.now()
    const ready: { fireAt: number; msg: PartialMsg }[] = []
    const remaining: typeof ready = []
    for (const pm of this._pendingMessages) {
      if (now >= pm.fireAt) ready.push(pm)
      else remaining.push(pm)
    }
    this._pendingMessages = remaining
    ready.sort((a, b) => a.fireAt - b.fireAt)
    for (const pm of ready) {
      (pm.msg as DecodeMessage).timestamp = pm.fireAt
      this._push(pm.msg)
    }
  }

  private _genInventory() {
    this._roundId++
    const freq = pickCh()
    const q = 2 + ((Math.random() * 4) | 0)
    const numTags = 1 + ((Math.random() * 3) | 0)
    const tags = pickTags(numTags)
    const session = ['S0', 'S1'][(Math.random() * 2) | 0]
    const m = ['FM0', 'Miller2', 'Miller4', 'Miller8'][(Math.random() * 4) | 0]
    let d = 0

    if (this._roundCounter % (3 + ((Math.random() * 3) | 0)) === 0) {
      const maskTag = tags[0]
      this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: session, action: 'A0', memBank: 'EPC', pointer: 32, length: 96, mask: maskTag.epc.replace(/ /g, '').slice(0, 12) + '...', truncate: false } } as PartialMsg)
      d += 4 + Math.random() * 4
    }

    this._schedule(d, { direction: 'R2T', command: 'Query', roundId: this._roundId, freq, params: { DR: '8', M: m, TRext: false, Sel: 'All', session, target: 'A', Q: q } } as PartialMsg)
    d += 2 + Math.random() * 2

    for (let ti = 0; ti < tags.length; ti++) {
      const tag = tags[ti]
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r }, tagEpc: null } as PartialMsg)
      d += 1 + Math.random() * 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 1.5 + Math.random() * 2
      this._schedule(d, { direction: 'T2R', command: 'EPC', roundId: this._roundId, freq, params: { pc: tag.pc, epc: tag.epc, crc: rHex(4) }, tagEpc: tag.epc } as PartialMsg)
      d += 1 + Math.random() * 2
      if (ti < tags.length - 1) {
        this._schedule(d, { direction: 'R2T', command: 'QueryRep', roundId: this._roundId, freq, params: { session } } as PartialMsg)
        d += 1.5 + Math.random() * 1.5
      }
    }
    this._schedule(d, { direction: 'R2T', command: 'QueryRep', roundId: this._roundId, freq, params: { session } } as PartialMsg)
    this._roundCounter++
  }

  private _genAccess() {
    this._roundId++
    const freq = pickCh()
    const tag = MOCK_TAG_POOL[(Math.random() * MOCK_TAG_POOL.length) | 0]
    const r = rn16()
    const handle = rn16()
    let d = 0

    this._schedule(d, { direction: 'R2T', command: 'ReqRN', roundId: this._roundId, freq, params: { rn16: r }, tagEpc: tag.epc } as PartialMsg)
    d += 2
    this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    d += 2

    const op = wPick(['Read', 'Write', 'Kill', 'Lock', 'BlockWrite', 'BlockErase'], [0.40, 0.25, 0.05, 0.10, 0.12, 0.08])

    if (op === 'Read') {
      const bank = ['Reserved', 'EPC', 'TID', 'User'][(Math.random() * 4) | 0]
      const wc = bank === 'TID' ? 4 : bank === 'Reserved' ? 2 : 6
      this._schedule(d, { direction: 'R2T', command: 'Read', roundId: this._roundId, freq, params: { memBank: bank, wordPtr: 0, wordCount: wc }, tagEpc: tag.epc } as PartialMsg)
      d += 3
      const data = bank === 'TID' ? tag.tid : bank === 'User' ? tag.user : bank === 'Reserved' ? (tag.killPwd + ' ' + tag.accessPwd) : tag.epc
      this._schedule(d, { direction: 'T2R', command: 'Data', roundId: this._roundId, freq, params: { memBank: bank, words: data }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Write') {
      this._schedule(d, { direction: 'R2T', command: 'Write', roundId: this._roundId, freq, params: { memBank: 'User', wordPtr: 0, data: rHex(4) }, tagEpc: tag.epc } as PartialMsg)
      d += 5
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Kill') {
      this._schedule(d, { direction: 'R2T', command: 'Kill', roundId: this._roundId, freq, params: { password: tag.killPwd.slice(0, 8), phase: 'first' }, tagEpc: tag.epc } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'R2T', command: 'Kill', roundId: this._roundId, freq, params: { password: tag.killPwd.slice(0, 8), phase: 'second' }, tagEpc: tag.epc } as PartialMsg)
      d += 3
      if (Math.random() > 0.3) {
        this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
      }
    } else if (op === 'Lock') {
      const payload = rHex(5).toUpperCase()
      this._schedule(d, { direction: 'R2T', command: 'Lock', roundId: this._roundId, freq, params: { payload, action: 'permalock-user' }, tagEpc: tag.epc } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'BlockWrite') {
      this._schedule(d, { direction: 'R2T', command: 'BlockWrite', roundId: this._roundId, freq, params: { memBank: 'User', wordPtr: 0, wordCount: 4, data: rHex(16) }, tagEpc: tag.epc } as PartialMsg)
      d += 6
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'BlockErase') {
      this._schedule(d, { direction: 'R2T', command: 'BlockErase', roundId: this._roundId, freq, params: { memBank: 'User', wordPtr: 0, wordCount: 4 }, tagEpc: tag.epc } as PartialMsg)
      d += 5
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    }
  }

  private _genSecurity() {
    this._roundId++
    const freq = pickCh()
    const tag = MOCK_TAG_POOL[(Math.random() * MOCK_TAG_POOL.length) | 0]
    const handle = rn16()
    let d = 0

    const op = wPick(['Authenticate', 'Challenge', 'Untraceable', 'FileOpen', 'TagPrivilege'], [0.35, 0.25, 0.20, 0.10, 0.10])

    if (op === 'Authenticate') {
      const mode = Math.random() > 0.5 ? 'TAM1' : 'TAM2'
      this._schedule(d, { direction: 'R2T', command: 'Authenticate', roundId: this._roundId, freq, params: { CSI: 'AES-128', mode, keyID: 0, challenge: rHex(32), msgLen: 128 }, tagEpc: tag.epc } as PartialMsg)
      d += 8
      this._schedule(d, { direction: 'T2R', command: 'AuthReply', roundId: this._roundId, freq, params: { response: rHex(32), CMAC: rHex(8), ...(mode === 'TAM2' ? { data: tag.tid } : {}) }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Challenge') {
      this._schedule(d, { direction: 'R2T', command: 'Challenge', roundId: this._roundId, freq, params: { CSI: 'AES-128', message: rHex(16) }, tagEpc: tag.epc } as PartialMsg)
      d += 5
      this._schedule(d, { direction: 'T2R', command: 'ChallengeReply', roundId: this._roundId, freq, params: { tagNonce: rHex(16) }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Untraceable') {
      this._schedule(d, { direction: 'R2T', command: 'Untraceable', roundId: this._roundId, freq, params: { setU: true, epcWordLen: 6, hideEPC: 'show-all', hideUser: false, tidPolicy: 'show-all', rangePolicy: 'normal', rxAttn: false }, tagEpc: tag.epc } as PartialMsg)
      d += 4
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'FileOpen') {
      this._schedule(d, { direction: 'R2T', command: 'FileOpen', roundId: this._roundId, freq, params: { fileNum: (Math.random() * 4) | 0 }, tagEpc: tag.epc } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'TagPrivilege') {
      this._schedule(d, { direction: 'R2T', command: 'TagPrivilege', roundId: this._roundId, freq, params: {}, tagEpc: tag.epc } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'T2R', command: 'Handle', roundId: this._roundId, freq, params: { handle }, tagEpc: tag.epc } as PartialMsg)
    }
  }

  private _genGen2X() {
    this._roundId++
    const freq = pickCh()
    const tag = MOCK_TAG_POOL[(Math.random() * MOCK_TAG_POOL.length) | 0]
    const handle = rn16()
    let d = 0

    const op = wPick(
      ['FastID', 'TagFocus', 'ProtectedMode', 'QueryX', 'QueryY', 'ReadVar', 'Authenticity', 'Integra'],
      [0.20, 0.15, 0.12, 0.15, 0.08, 0.12, 0.10, 0.08],
    )

    if (op === 'FastID') {
      this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'SL', action: 'A0', memBank: 'TID', pointer: 0, length: 0, mask: '', note: '[Gen2X] FastID enable' } } as PartialMsg)
      d += 3
      const q = 2 + ((Math.random() * 3) | 0)
      this._schedule(d, { direction: 'R2T', command: 'Query', roundId: this._roundId, freq, params: { DR: '8', M: 'FM0', TRext: false, Sel: 'SL', session: 'S0', target: 'A', Q: q } } as PartialMsg)
      d += 2
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r }, tagEpc: null } as PartialMsg)
      d += 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'T2R', command: 'XPC_EPC', roundId: this._roundId, freq, params: { pc: tag.pc, xpc_w1: rHex(4), xpc_w2: rHex(4), epc: tag.epc, tid: tag.tid, crc: rHex(4) }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'TagFocus') {
      this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'S1', action: 'A5', memBank: 'EPC', pointer: 0, length: 0, mask: '', note: '[Gen2X] TagFocus enable' } } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'R2T', command: 'Query', roundId: this._roundId, freq, params: { DR: '8', M: 'FM0', TRext: false, Sel: 'All', session: 'S1', target: 'A', Q: 3 } } as PartialMsg)
      d += 2
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'T2R', command: 'EPC', roundId: this._roundId, freq, params: { pc: tag.pc, epc: tag.epc, crc: rHex(4), note: 'TagFocus: new tag only' }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'ProtectedMode') {
      this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'SL', action: 'A0', memBank: 'EPC', pointer: 0, length: 0, mask: '', note: '[Gen2X] Protected Mode unlock' } } as PartialMsg)
      d += 3
      this._schedule(d, { direction: 'R2T', command: 'Query', roundId: this._roundId, freq, params: { DR: '8', M: 'FM0', TRext: false, Sel: 'SL', session: 'S0', target: 'A', Q: 2 } } as PartialMsg)
      d += 2
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'T2R', command: 'EPC', roundId: this._roundId, freq, params: { pc: tag.pc, epc: tag.epc, crc: rHex(4), note: 'unlocked via PIN' }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'QueryX') {
      this._schedule(d, { direction: 'R2T', command: 'QueryX', roundId: this._roundId, freq, params: { ackData: 'EPC+TID', replyCRC: true, session: 'S0', target: 'A', Q: 3, memBank: 'EPC', pointer: 32, compare: '=', mask: tag.epc.replace(/ /g, '').slice(0, 8) + '...' } } as PartialMsg)
      d += 3
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'T2R', command: 'EPC', roundId: this._roundId, freq, params: { pc: tag.pc, epc: tag.epc, tid: tag.tid, crc: rHex(4) }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'QueryY') {
      this._schedule(d, { direction: 'R2T', command: 'QueryY', roundId: this._roundId, freq, params: { ackData: 'EPC', replyCRC: true, session: 'S0', target: 'A', Q: 4, filterMode: 'inclusive' } } as PartialMsg)
      d += 3
      const r = rn16()
      this._schedule(d, { direction: 'T2R', command: 'RN16', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 1.5
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: r } } as PartialMsg)
      d += 2
      this._schedule(d, { direction: 'T2R', command: 'EPC', roundId: this._roundId, freq, params: { pc: tag.pc, epc: tag.epc, crc: rHex(4) }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'ReadVar') {
      this._schedule(d, { direction: 'R2T', command: 'ReadVar', roundId: this._roundId, freq, params: { memBank: 'User', wordPtr: 0 }, tagEpc: tag.epc } as PartialMsg)
      d += 4
      const nw = 4 + ((Math.random() * 4) | 0)
      this._schedule(d, { direction: 'T2R', command: 'DataVar', roundId: this._roundId, freq, params: { memBank: 'User', words: tag.user, numWords: nw, moreWords: 0, parity: true }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Authenticity') {
      this._schedule(d, { direction: 'R2T', command: 'Authenticate', roundId: this._roundId, freq, params: { CSI: 'AES-128', mode: 'TAM1', keyID: 0, challenge: rHex(32), msgLen: 128, note: '[Gen2X] Authenticity' }, tagEpc: tag.epc } as PartialMsg)
      d += 8
      this._schedule(d, { direction: 'T2R', command: 'AuthReply', roundId: this._roundId, freq, params: { response: rHex(32), CMAC: rHex(8), valid: Math.random() > 0.1 }, tagEpc: tag.epc } as PartialMsg)
    } else if (op === 'Integra') {
      this._schedule(d, { direction: 'R2T', command: 'Read', roundId: this._roundId, freq, params: { memBank: 'TID', wordPtr: 0, wordCount: 8, note: '[Gen2X] Integra diagnostic' }, tagEpc: tag.epc } as PartialMsg)
      d += 5
      this._schedule(d, { direction: 'T2R', command: 'Data', roundId: this._roundId, freq, params: { memBank: 'TID', words: tag.tid + ' ' + rHex(8), note: 'Integra: chip healthy' }, tagEpc: tag.epc } as PartialMsg)
    }
  }

  /**
   * Reader-only mode: generates only R2T commands visible to an RTL-SDR.
   * Tag backscatter (T2R) is not detectable with receive-only SDR hardware.
   */
  private _genReaderOnly() {
    this._roundId++
    const freq = pickCh()
    const q = 2 + ((Math.random() * 4) | 0)
    const session = ['S0', 'S1'][(Math.random() * 2) | 0]
    const m = ['FM0', 'Miller2', 'Miller4', 'Miller8'][(Math.random() * 4) | 0]
    let d = 0

    // Occasionally start with a Select
    if (this._roundCounter % (2 + ((Math.random() * 3) | 0)) === 0) {
      const tag = MOCK_TAG_POOL[(Math.random() * MOCK_TAG_POOL.length) | 0]
      const op = wPick(
        ['select-epc', 'select-tid', 'fastid', 'tagfocus', 'protected'],
        [0.40, 0.15, 0.15, 0.15, 0.15],
      )

      if (op === 'fastid') {
        this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'SL', action: 'A0', memBank: 'TID', pointer: 0, length: 0, mask: '', note: '[Gen2X] FastID enable' } } as PartialMsg)
      } else if (op === 'tagfocus') {
        this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'S1', action: 'A5', memBank: 'EPC', pointer: 0, length: 0, mask: '', note: '[Gen2X] TagFocus enable' } } as PartialMsg)
      } else if (op === 'protected') {
        this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: 'SL', action: 'A0', memBank: 'EPC', pointer: 0, length: 0, mask: '', note: '[Gen2X] Protected Mode unlock' } } as PartialMsg)
      } else if (op === 'select-tid') {
        this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: session, action: 'A0', memBank: 'TID', pointer: 0, length: 32, mask: tag.tid.replace(/ /g, '').slice(0, 8) + '...' } } as PartialMsg)
      } else {
        this._schedule(d, { direction: 'R2T', command: 'Select', roundId: this._roundId, freq, params: { target: session, action: 'A0', memBank: 'EPC', pointer: 32, length: 96, mask: tag.epc.replace(/ /g, '').slice(0, 12) + '...' } } as PartialMsg)
      }
      d += 3 + Math.random() * 3
    }

    // Query command (always present)
    const queryType = wPick(['Query', 'QueryX', 'QueryY'], [0.75, 0.18, 0.07])

    if (queryType === 'QueryX') {
      const tag = MOCK_TAG_POOL[(Math.random() * MOCK_TAG_POOL.length) | 0]
      this._schedule(d, { direction: 'R2T', command: 'QueryX', roundId: this._roundId, freq, params: { ackData: 'EPC+TID', replyCRC: true, session, target: 'A', Q: q, memBank: 'EPC', pointer: 32, compare: '=', mask: tag.epc.replace(/ /g, '').slice(0, 8) + '...' } } as PartialMsg)
    } else if (queryType === 'QueryY') {
      this._schedule(d, { direction: 'R2T', command: 'QueryY', roundId: this._roundId, freq, params: { ackData: 'EPC', replyCRC: true, session, target: 'A', Q: q, filterMode: 'inclusive' } } as PartialMsg)
    } else {
      this._schedule(d, { direction: 'R2T', command: 'Query', roundId: this._roundId, freq, params: { DR: '8', M: m, TRext: false, Sel: 'All', session, target: 'A', Q: q } } as PartialMsg)
    }
    d += 2 + Math.random() * 2

    // Simulate the reader-side commands during tag singulation
    // RTL-SDR sees ACKs but not RN16/EPC responses
    const numSlots = 1 + ((Math.random() * 4) | 0)
    for (let i = 0; i < numSlots; i++) {
      // ACK (reader sends this after receiving RN16 — we see the ACK but not the RN16)
      this._schedule(d, { direction: 'R2T', command: 'ACK', roundId: this._roundId, freq, params: { rn16: rn16() } } as PartialMsg)
      d += 2 + Math.random() * 3

      // Sometimes reader follows up with access commands
      if (Math.random() < 0.25) {
        const accessOp = wPick(
          ['ReqRN', 'Read', 'Write', 'Lock', 'Kill', 'Authenticate', 'Challenge', 'Untraceable'],
          [0.25, 0.30, 0.15, 0.08, 0.02, 0.10, 0.05, 0.05],
        )
        if (accessOp === 'ReqRN') {
          this._schedule(d, { direction: 'R2T', command: 'ReqRN', roundId: this._roundId, freq, params: { rn16: rn16() } } as PartialMsg)
          d += 2 + Math.random() * 2
          // After ReqRN, reader may issue a Read or Write
          if (Math.random() < 0.6) {
            const bank = ['Reserved', 'EPC', 'TID', 'User'][(Math.random() * 4) | 0]
            const wc = bank === 'TID' ? 4 : bank === 'Reserved' ? 2 : 6
            this._schedule(d, { direction: 'R2T', command: 'Read', roundId: this._roundId, freq, params: { memBank: bank, wordPtr: 0, wordCount: wc } } as PartialMsg)
            d += 3 + Math.random() * 2
          }
        } else if (accessOp === 'Read') {
          const bank = ['Reserved', 'EPC', 'TID', 'User'][(Math.random() * 4) | 0]
          const wc = bank === 'TID' ? 4 : bank === 'Reserved' ? 2 : 6
          this._schedule(d, { direction: 'R2T', command: 'Read', roundId: this._roundId, freq, params: { memBank: bank, wordPtr: 0, wordCount: wc } } as PartialMsg)
          d += 3 + Math.random() * 2
        } else if (accessOp === 'Write') {
          this._schedule(d, { direction: 'R2T', command: 'Write', roundId: this._roundId, freq, params: { memBank: 'User', wordPtr: 0, data: rHex(4) } } as PartialMsg)
          d += 4 + Math.random() * 2
        } else if (accessOp === 'Lock') {
          this._schedule(d, { direction: 'R2T', command: 'Lock', roundId: this._roundId, freq, params: { payload: rHex(5).toUpperCase(), action: 'permalock-user' } } as PartialMsg)
          d += 3
        } else if (accessOp === 'Kill') {
          this._schedule(d, { direction: 'R2T', command: 'Kill', roundId: this._roundId, freq, params: { password: rHex(8), phase: 'first' } } as PartialMsg)
          d += 3
        } else if (accessOp === 'Authenticate') {
          this._schedule(d, { direction: 'R2T', command: 'Authenticate', roundId: this._roundId, freq, params: { CSI: 'AES-128', mode: Math.random() > 0.5 ? 'TAM1' : 'TAM2', keyID: 0, challenge: rHex(32), msgLen: 128 } } as PartialMsg)
          d += 6 + Math.random() * 3
        } else if (accessOp === 'Challenge') {
          this._schedule(d, { direction: 'R2T', command: 'Challenge', roundId: this._roundId, freq, params: { CSI: 'AES-128', message: rHex(16) } } as PartialMsg)
          d += 4 + Math.random() * 2
        } else if (accessOp === 'Untraceable') {
          this._schedule(d, { direction: 'R2T', command: 'Untraceable', roundId: this._roundId, freq, params: { setU: true, epcWordLen: 6, hideEPC: 'show-all', hideUser: false, tidPolicy: 'show-all', rangePolicy: 'normal' } } as PartialMsg)
          d += 3 + Math.random() * 2
        }
      }

      // QueryRep between slots
      if (i < numSlots - 1) {
        this._schedule(d, { direction: 'R2T', command: 'QueryRep', roundId: this._roundId, freq, params: { session } } as PartialMsg)
        d += 1.5 + Math.random() * 2
      }
    }

    // Final QueryRep to close the round
    this._schedule(d, { direction: 'R2T', command: 'QueryRep', roundId: this._roundId, freq, params: { session } } as PartialMsg)
    this._roundCounter++
  }
}

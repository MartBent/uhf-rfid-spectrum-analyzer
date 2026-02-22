import type { CanvasColors } from '../theme'

export function waterfallColor(db: number, refLevel: number, range: number, _colors: CanvasColors) {
  const norm = Math.max(0, Math.min(1, (db - (refLevel - range)) / range))
  let r: number, g: number, b: number
  if (norm < 0.15) {
    const t = norm / 0.15; r = 0; g = 0; b = Math.floor(80 * t)
  } else if (norm < 0.3) {
    const t = (norm - 0.15) / 0.15; r = 0; g = Math.floor(100 * t); b = 80 + Math.floor(100 * t)
  } else if (norm < 0.5) {
    const t = (norm - 0.3) / 0.2; r = 0; g = 100 + Math.floor(155 * t); b = Math.floor(180 * (1 - t))
  } else if (norm < 0.7) {
    const t = (norm - 0.5) / 0.2; r = Math.floor(255 * t); g = 255; b = 0
  } else if (norm < 0.9) {
    const t = (norm - 0.7) / 0.2; r = 255; g = Math.floor(255 * (1 - t)); b = 0
  } else {
    const t = (norm - 0.9) / 0.1; r = 255; g = Math.floor(200 * t); b = Math.floor(200 * t)
  }
  return `rgb(${r},${g},${b})`
}

const CMD_COLORS: Record<string, string> = {
  inventory: '#00d4ff',
  access: '#ffcc00',
  security: '#c878ff',
  gen2x: '#ff78c0',
  response: '#00ff88',
}

export function cmdColor(cmd: string) {
  if (['Query', 'QueryRep', 'QueryAdjust', 'Select', 'ACK', 'NAK'].includes(cmd)) return CMD_COLORS.inventory
  if (['ReqRN', 'Read', 'Write', 'Kill', 'Lock', 'BlockWrite', 'BlockErase'].includes(cmd)) return CMD_COLORS.access
  if (['Authenticate', 'Challenge', 'Untraceable', 'FileOpen', 'TagPrivilege'].includes(cmd)) return CMD_COLORS.security
  if (['QueryX', 'QueryY', 'ReadVar', 'XPC_EPC', 'DataVar'].includes(cmd)) return CMD_COLORS.gen2x
  if (['RN16', 'EPC', 'Handle', 'Data', 'AuthReply', 'ChallengeReply'].includes(cmd)) return CMD_COLORS.response
  return '#607080'
}

export function getCmdClass(cmd: string) {
  if (['Query', 'QueryRep', 'QueryAdjust', 'Select', 'ACK', 'NAK'].includes(cmd)) return 'inventory'
  if (['ReqRN', 'Read', 'Write', 'Kill', 'Lock', 'BlockWrite', 'BlockErase'].includes(cmd)) return 'access'
  if (['Authenticate', 'Challenge', 'Untraceable', 'FileOpen', 'TagPrivilege'].includes(cmd)) return 'security'
  if (['QueryX', 'QueryY', 'ReadVar', 'XPC_EPC', 'DataVar'].includes(cmd)) return 'gen2x'
  if (['RN16', 'EPC', 'Handle', 'Data', 'AuthReply', 'ChallengeReply'].includes(cmd)) return 'response'
  return ''
}

export function fmtDetail(msg: { command: string; params: Record<string, unknown> }) {
  const p = msg.params || {}
  const note = p.note ? ` ${p.note}` : ''
  switch (msg.command) {
    case 'Select': return `${p.memBank} target=${p.target} action=${p.action} mask=${p.mask || ''}${note}`
    case 'Query': return `S=${p.session} T=${p.target} Q=${p.Q} M=${p.M} DR=${p.DR}${note}`
    case 'QueryRep': return `session=${p.session}`
    case 'QueryAdjust': return `session=${p.session} ${p.upDn || ''}`
    case 'ACK': return `RN16=${p.rn16}`
    case 'NAK': return ''
    case 'ReqRN': return `RN16=${p.rn16}`
    case 'RN16': return String(p.rn16 || '')
    case 'EPC': return `PC:${p.pc} EPC:${p.epc} CRC:${p.crc}${p.tid ? ' TID:' + p.tid : ''}${note}`
    case 'XPC_EPC': return `PC:${p.pc} XPC:${p.xpc_w1}/${p.xpc_w2} EPC:${p.epc} TID:${p.tid}`
    case 'Handle': return String(p.handle || '')
    case 'Read': return `${p.memBank}[${p.wordPtr}:${p.wordCount}]${note}`
    case 'Write': return `${p.memBank}[${p.wordPtr}]=${p.data}`
    case 'Data': return `${p.memBank}: ${p.words}${note}`
    case 'Kill': return `pwd=${p.password} ${p.phase || ''}`
    case 'Lock': return `mask=${p.payload} ${p.action || ''}`
    case 'BlockWrite': return `${p.memBank}[${p.wordPtr}:${p.wordCount}] data=${p.data}`
    case 'BlockErase': return `${p.memBank}[${p.wordPtr}:${p.wordCount}]`
    case 'Authenticate': return `${p.CSI} ${p.mode} key=${p.keyID} challenge=${String(p.challenge || '').slice(0, 16)}...${note}`
    case 'AuthReply': return `resp=${String(p.response || '').slice(0, 16)}... CMAC=${p.CMAC}${p.valid !== undefined ? ' valid=' + p.valid : ''}`
    case 'Challenge': return `${p.CSI} msg=${p.message}`
    case 'ChallengeReply': return `nonce=${p.tagNonce}`
    case 'Untraceable': return `U=${p.setU} epcLen=${p.epcWordLen} hide=${p.hideEPC} tid=${p.tidPolicy} range=${p.rangePolicy}`
    case 'FileOpen': return `file=${p.fileNum}`
    case 'TagPrivilege': return ''
    case 'QueryX': return `ack=${p.ackData} crc=${p.replyCRC} S=${p.session} T=${p.target} Q=${p.Q} ${p.memBank}[${p.pointer}] ${p.compare} ${p.mask}`
    case 'QueryY': return `ack=${p.ackData} crc=${p.replyCRC} S=${p.session} T=${p.target} Q=${p.Q} filter=${p.filterMode}`
    case 'ReadVar': return `${p.memBank}[${p.wordPtr}]`
    case 'DataVar': return `${p.memBank}: ${p.words} (${p.numWords}w +${p.moreWords})`
    default: return JSON.stringify(p)
  }
}

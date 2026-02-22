import { create } from 'zustand'

export interface DecodeMessage {
  id: number
  direction: 'R2T' | 'T2R'
  command: string
  roundId: number
  freq: number
  params: Record<string, unknown>
  tagEpc?: string | null
  timestamp: number
}

interface DecodeState {
  log: DecodeMessage[]
  roundCount: number
  paused: boolean
  enabled: boolean
  sequenceMode: string
  lastRoundIdRendered: number

  push: (msg: DecodeMessage) => void
  clear: () => void
  setPaused: (v: boolean) => void
  setEnabled: (v: boolean) => void
  setSequenceMode: (v: string) => void
}

const MAX_LOG = 500

let _lastRoundId = -1

export const useDecodeStore = create<DecodeState>((set, get) => ({
  log: [],
  roundCount: 0,
  paused: false,
  enabled: true,
  sequenceMode: 'reader-only',
  lastRoundIdRendered: -1,

  push: (msg) => {
    const state = get()
    if (!state.enabled) return

    const log = [...state.log, msg]
    if (log.length > MAX_LOG) log.shift()

    let roundCount = state.roundCount
    if (msg.roundId !== _lastRoundId) {
      roundCount++
      _lastRoundId = msg.roundId
    }

    set({ log, roundCount })
  },

  clear: () => {
    _lastRoundId = -1
    set({
      log: [],
      roundCount: 0,
      lastRoundIdRendered: -1,
    })
  },

  setPaused: (paused) => set({ paused }),
  setEnabled: (enabled) => set({ enabled }),
  setSequenceMode: (sequenceMode) => set({ sequenceMode }),
}))

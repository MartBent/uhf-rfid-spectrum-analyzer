"""
UHF RFID Decoder Library

Standalone RFID decode + signal processing + spectrum analysis for EPC Gen2.
Can be used independently of the WebSocket server.
"""

import ctypes
import ctypes.util
import logging
import math
import os
import random
import time

import numpy as np
from scipy.signal.windows import blackmanharris

try:
    from rtlsdr import RtlSdr
    HAS_RTLSDR = True
except ImportError:
    HAS_RTLSDR = False

log = logging.getLogger("rfid-spectrum")

__all__ = [
    # Constants
    "HAS_RTLSDR",
    "DEFAULT_CENTER_FREQ",
    "DEFAULT_SAMPLE_RATE",
    "DEFAULT_GAIN",
    "DEFAULT_FFT_SIZE",
    "RFID_BANDS",
    # CRC
    "crc5",
    "crc16",
    # Bit utilities
    "bits_to_int",
    "bits_to_hex",
    "extract_ebv",
    # Gen2 parser
    "parse_gen2_command",
    # Classes
    "PIEDecoder",
    "MockRFIDDecoder",
    "SpectrumAnalyzer",
    "SimulatedAnalyzer",
    # Device discovery
    "enumerate_devices",
]

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_CENTER_FREQ = 915e6
DEFAULT_SAMPLE_RATE = 2.4e6
DEFAULT_GAIN = 40
DEFAULT_FFT_SIZE = 1024

RFID_BANDS = {
    "FCC (US)":  {"start": 902.0, "end": 928.0, "channels": 50, "power": "1W ERP"},
    "ETSI (EU)": {"start": 865.6, "end": 867.6, "channels": 4,  "power": "2W ERP"},
    "China":     {"start": 920.0, "end": 925.0, "channels": 16, "power": "2W ERP"},
    "Japan":     {"start": 916.8, "end": 920.4, "channels": 9,  "power": "250mW"},
    "Korea":     {"start": 917.0, "end": 923.5, "channels": 13, "power": "200mW"},
    "Brazil":    {"start": 902.0, "end": 907.5, "channels": 11, "power": "4W EIRP"},
    "Australia": {"start": 920.0, "end": 926.0, "channels": 12, "power": "1W EIRP"},
}


# ===========================================================================
# CRC functions (ported from pie-decoder.js)
# ===========================================================================

CRC5_PRESET = 0x09
CRC5_POLY = 0x29

def crc5(bits):
    crc = CRC5_PRESET
    for b in bits:
        msb = (crc >> 4) & 1
        crc = ((crc << 1) | (b & 1)) & 0x1F
        if msb:
            crc ^= CRC5_POLY
    return crc

CRC16_PRESET = 0xFFFF
CRC16_POLY = 0x1021

def crc16(bits):
    crc = CRC16_PRESET
    for b in bits:
        msb = (crc >> 15) & 1
        crc = ((crc << 1) | (b & 1)) & 0xFFFF
        if msb:
            crc ^= CRC16_POLY
    return crc


# ===========================================================================
# Bit extraction utilities
# ===========================================================================

def bits_to_int(bits, start, length):
    val = 0
    for i in range(length):
        val = (val << 1) | (bits[start + i] & 1)
    return val

def bits_to_hex(bits, start, length):
    nybbles = math.ceil(length / 4)
    hex_str = ""
    for n in range(nybbles):
        bit_ofs = start + n * 4
        remain = min(4, length - n * 4)
        val = 0
        for i in range(remain):
            val = (val << 1) | (bits[bit_ofs + i] & 1)
        if remain < 4:
            val <<= (4 - remain)
        hex_str += format(val, "X")
    return hex_str

def extract_ebv(bits, start):
    value = 0
    pos = start
    more = True
    while more and pos < len(bits):
        more = bits[pos] == 1
        pos += 1
        for _ in range(7):
            if pos >= len(bits):
                break
            value = (value << 1) | (bits[pos] & 1)
            pos += 1
    return value, pos - start


# ===========================================================================
# Gen2 Command Parser
# ===========================================================================

SESSION_MAP = ["S0", "S1", "S2", "S3"]
TARGET_MAP = ["A", "B"]
M_MAP = ["FM0", "Miller2", "Miller4", "Miller8"]
DR_MAP = ["8", "64/3"]
SEL_MAP = ["All", "All", "~SL", "SL"]
MEMBANK_MAP = ["Reserved", "EPC", "TID", "User"]
ACTION_MAP = ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"]


def parse_gen2_command(bits):
    if len(bits) < 2:
        return None

    prefix2 = bits_to_int(bits, 0, 2)
    if prefix2 == 0b00:
        return _parse_query_rep(bits)
    if prefix2 == 0b01:
        return _parse_ack(bits)

    if len(bits) < 4:
        return None
    prefix4 = bits_to_int(bits, 0, 4)
    if prefix4 == 0b1000:
        return _parse_query(bits)
    if prefix4 == 0b1001:
        return _parse_query_adjust(bits)
    if prefix4 == 0b1010:
        return _parse_select(bits)
    if prefix4 == 0b1011:
        return {"command": "NAK", "params": {}, "crcValid": None}

    if len(bits) < 8:
        return None
    prefix8 = bits_to_int(bits, 0, 8)

    parsers = {
        0xC0: _parse_req_rn,
        0xC1: _parse_read,
        0xC2: _parse_write,
        0xC3: _parse_kill,
        0xC4: _parse_lock,
        0xC5: _parse_access,
        0xC6: _parse_block_write,
        0xC7: _parse_block_erase,
        0xD0: _parse_authenticate,
        0xD1: _parse_auth_comm,
        0xD2: _parse_secure_comm,
        0xD4: _parse_tag_privilege,
        0xE0: _parse_query_x,
        0xE1: _parse_query_y,
    }

    parser = parsers.get(prefix8)
    if parser:
        return parser(bits)

    return {
        "command": "Unknown",
        "params": {"prefix": bits_to_hex(bits, 0, min(len(bits), 16)), "totalBits": len(bits)},
        "crcValid": None,
    }


def _parse_query_rep(bits):
    if len(bits) < 4:
        return {"command": "QueryRep", "params": {}, "crcValid": None}
    session = SESSION_MAP[bits_to_int(bits, 2, 2)]
    return {"command": "QueryRep", "params": {"session": session}, "crcValid": None}


def _parse_ack(bits):
    if len(bits) < 18:
        return {"command": "ACK", "params": {}, "crcValid": None}
    rn16 = bits_to_hex(bits, 2, 16)
    return {"command": "ACK", "params": {"rn16": rn16}, "crcValid": None}


def _parse_query(bits):
    if len(bits) < 22:
        return {"command": "Query", "params": {"partial": True}, "crcValid": None}
    DR = DR_MAP[bits_to_int(bits, 4, 1)]
    M = M_MAP[bits_to_int(bits, 5, 2)]
    TRext = bits[7] == 1
    Sel = SEL_MAP[bits_to_int(bits, 8, 2)]
    session = SESSION_MAP[bits_to_int(bits, 10, 2)]
    target = TARGET_MAP[bits_to_int(bits, 12, 1)]
    Q = bits_to_int(bits, 13, 4)
    crc_bits = bits[:17]
    crc_val = bits_to_int(bits, 17, 5)
    valid = crc5(crc_bits) == crc_val
    return {
        "command": "Query",
        "params": {"DR": DR, "M": M, "TRext": TRext, "Sel": Sel, "session": session, "target": target, "Q": Q},
        "crcValid": valid,
    }


def _parse_query_adjust(bits):
    if len(bits) < 9:
        return {"command": "QueryAdjust", "params": {}, "crcValid": None}
    session = SESSION_MAP[bits_to_int(bits, 4, 2)]
    up_dn_raw = bits_to_int(bits, 6, 3)
    up_dn = "unchanged"
    if up_dn_raw == 0b110:
        up_dn = "up"
    elif up_dn_raw == 0b011:
        up_dn = "down"
    return {"command": "QueryAdjust", "params": {"session": session, "upDn": up_dn}, "crcValid": None}


def _parse_select(bits):
    if len(bits) < 26:
        return {"command": "Select", "params": {"partial": True}, "crcValid": None}
    target_raw = bits_to_int(bits, 4, 3)
    action = ACTION_MAP[bits_to_int(bits, 7, 3)]
    mem_bank = MEMBANK_MAP[bits_to_int(bits, 10, 2)]
    ptr_val, ptr_consumed = extract_ebv(bits, 12)
    pos = 12 + ptr_consumed
    if pos + 8 > len(bits):
        target_str = SESSION_MAP[target_raw] if target_raw <= 3 else "SL"
        return {"command": "Select", "params": {"target": target_str, "action": action, "memBank": mem_bank, "pointer": ptr_val}, "crcValid": None}
    length = bits_to_int(bits, pos, 8)
    pos += 8
    mask = ""
    if pos + length <= len(bits):
        mask = bits_to_hex(bits, pos, length)
        pos += length
    truncate = False
    if pos < len(bits):
        truncate = bits[pos] == 1
        pos += 1
    crc_valid = None
    if pos + 16 <= len(bits):
        data_bits = bits[:pos]
        crc_valid = crc16(data_bits) == 0
    target_str = SESSION_MAP[target_raw] if target_raw <= 3 else ("SL" if target_raw == 4 else f"inv({target_raw})")
    return {
        "command": "Select",
        "params": {"target": target_str, "action": action, "memBank": mem_bank, "pointer": ptr_val, "length": length, "mask": mask, "truncate": truncate},
        "crcValid": crc_valid,
    }


def _parse_req_rn(bits):
    if len(bits) < 40:
        return {"command": "ReqRN", "params": {"partial": True}, "crcValid": None}
    rn16 = bits_to_hex(bits, 8, 16)
    crc_val = crc16(bits[:24])
    crc_expected = bits_to_int(bits, 24, 16)
    return {"command": "ReqRN", "params": {"rn16": rn16}, "crcValid": crc_val == crc_expected}


def _parse_read(bits):
    if len(bits) < 26:
        return {"command": "Read", "params": {"partial": True}, "crcValid": None}
    mem_bank = MEMBANK_MAP[bits_to_int(bits, 8, 2)]
    ptr_val, ptr_consumed = extract_ebv(bits, 10)
    pos = 10 + ptr_consumed
    word_count = 0
    if pos + 8 <= len(bits):
        word_count = bits_to_int(bits, pos, 8)
    return {"command": "Read", "params": {"memBank": mem_bank, "wordPtr": ptr_val, "wordCount": word_count}, "crcValid": None}


def _parse_write(bits):
    if len(bits) < 26:
        return {"command": "Write", "params": {"partial": True}, "crcValid": None}
    mem_bank = MEMBANK_MAP[bits_to_int(bits, 8, 2)]
    ptr_val, ptr_consumed = extract_ebv(bits, 10)
    pos = 10 + ptr_consumed
    data = ""
    if pos + 16 <= len(bits):
        data = bits_to_hex(bits, pos, 16)
    return {"command": "Write", "params": {"memBank": mem_bank, "wordPtr": ptr_val, "data": data}, "crcValid": None}


def _parse_kill(bits):
    if len(bits) < 40:
        return {"command": "Kill", "params": {"partial": True}, "crcValid": None}
    password = bits_to_hex(bits, 8, 16)
    return {"command": "Kill", "params": {"password": password}, "crcValid": None}


def _parse_lock(bits):
    if len(bits) < 28:
        return {"command": "Lock", "params": {"partial": True}, "crcValid": None}
    payload = bits_to_hex(bits, 8, 20)
    return {"command": "Lock", "params": {"payload": payload}, "crcValid": None}


def _parse_access(bits):
    if len(bits) < 40:
        return {"command": "Access", "params": {"partial": True}, "crcValid": None}
    password = bits_to_hex(bits, 8, 16)
    return {"command": "Access", "params": {"password": password}, "crcValid": None}


def _parse_block_write(bits):
    if len(bits) < 26:
        return {"command": "BlockWrite", "params": {"partial": True}, "crcValid": None}
    mem_bank = MEMBANK_MAP[bits_to_int(bits, 8, 2)]
    ptr_val, ptr_consumed = extract_ebv(bits, 10)
    pos = 10 + ptr_consumed
    word_count = 0
    data = ""
    if pos + 8 <= len(bits):
        word_count = bits_to_int(bits, pos, 8)
        pos += 8
    data_bits = word_count * 16
    if pos + data_bits <= len(bits):
        data = bits_to_hex(bits, pos, data_bits)
    return {"command": "BlockWrite", "params": {"memBank": mem_bank, "wordPtr": ptr_val, "wordCount": word_count, "data": data}, "crcValid": None}


def _parse_block_erase(bits):
    if len(bits) < 26:
        return {"command": "BlockErase", "params": {"partial": True}, "crcValid": None}
    mem_bank = MEMBANK_MAP[bits_to_int(bits, 8, 2)]
    ptr_val, ptr_consumed = extract_ebv(bits, 10)
    pos = 10 + ptr_consumed
    word_count = 0
    if pos + 8 <= len(bits):
        word_count = bits_to_int(bits, pos, 8)
    return {"command": "BlockErase", "params": {"memBank": mem_bank, "wordPtr": ptr_val, "wordCount": word_count}, "crcValid": None}


def _parse_authenticate(bits):
    if len(bits) < 10:
        return {"command": "Authenticate", "params": {"partial": True}, "crcValid": None}
    csi = bits_to_int(bits, 8, 2)
    csi_str = "Crypto Suite 0" if csi == 0 else ("AES-128" if csi == 1 else f"CSI({csi})")
    raw = bits_to_hex(bits, 10, min(len(bits) - 10, 128)) if len(bits) > 10 else ""
    return {"command": "Authenticate", "params": {"CSI": csi_str, "rawBits": raw}, "crcValid": None}


def _parse_auth_comm(bits):
    raw = bits_to_hex(bits, 8, min(len(bits) - 8, 128)) if len(bits) > 8 else ""
    return {"command": "AuthComm", "params": {"rawBits": raw}, "crcValid": None}


def _parse_secure_comm(bits):
    raw = bits_to_hex(bits, 8, min(len(bits) - 8, 128)) if len(bits) > 8 else ""
    return {"command": "SecureComm", "params": {"rawBits": raw}, "crcValid": None}


def _parse_tag_privilege(bits):
    raw = bits_to_hex(bits, 8, min(len(bits) - 8, 128)) if len(bits) > 8 else ""
    return {"command": "TagPrivilege", "params": {"rawBits": raw}, "crcValid": None}


def _parse_query_x(bits):
    raw = bits_to_hex(bits, 8, min(len(bits) - 8, 128)) if len(bits) > 8 else ""
    return {"command": "QueryX", "params": {"rawBits": raw}, "crcValid": None}


def _parse_query_y(bits):
    raw = bits_to_hex(bits, 8, min(len(bits) - 8, 128)) if len(bits) > 8 else ""
    return {"command": "QueryY", "params": {"rawBits": raw}, "crcValid": None}


# ===========================================================================
# PIE Decoder — Signal Processing + State Machine
# ===========================================================================

class PIEDecoder:
    """Decodes EPC Gen2 reader commands from raw IQ samples using PIE encoding."""

    IDLE = 0
    WAIT_DELIMITER = 1
    WAIT_DATA0 = 2
    WAIT_RTCAL = 3
    DECODING_BITS = 4

    def __init__(self, sample_rate=2400000, center_freq_mhz=915):
        self.sample_rate = sample_rate
        self.center_freq_mhz = center_freq_mhz

        # Lowpass filter
        self._lp_alpha = min(1.0, 2 * math.pi * 100000 / sample_rate)
        self._lp_state = 0.0

        # Adaptive threshold
        self._ema_high = 0.0
        self._ema_low = 0.0
        self._ema_alpha = 0.002
        self._threshold = 0.0
        self._threshold_initialized = False

        # Edge detection
        self._prev_binary = 0
        self._global_sample_offset = 0
        self._last_edge_offset = 0

        # PIE state machine
        self._state = self.IDLE
        self._tari = 0
        self._rtcal = 0
        self._pivot = 0
        self._bits = []
        self._symbol_start = 0
        self._cw_timeout = 0

        # Timing limits in microseconds
        self._delimiter_min_us = 8
        self._delimiter_max_us = 19
        self._tari_min_us = 6.25
        self._tari_max_us = 25

        # Round tracking
        self._round_id = 0
        self._pending_select_round_id = None

        # Message collection
        self._messages = []
        self._msg_id = 0

        # Stats
        self.stats = {"preambles_seen": 0, "commands_decoded": 0, "crc_errors": 0}

    def set_center_freq(self, mhz):
        self.center_freq_mhz = mhz

    def reset(self):
        self._state = self.IDLE
        self._bits = []
        self._lp_state = 0.0
        self._prev_binary = 0
        self._ema_high = 0.0
        self._ema_low = 0.0
        self._threshold_initialized = False
        self._global_sample_offset = 0

    def process(self, samples):
        """Process complex IQ samples. Returns list of decoded message dicts."""
        self._messages = []
        envelope = np.abs(samples)
        n = len(envelope)
        if n == 0:
            return []

        # Lowpass filter (vectorized would be better but sequential IIR is simple)
        filtered = np.empty(n, dtype=np.float64)
        lp = self._lp_state
        a = self._lp_alpha
        for i in range(n):
            lp += a * (envelope[i] - lp)
            filtered[i] = lp
        self._lp_state = lp

        # Adaptive threshold (subsample for speed)
        ema_a = self._ema_alpha
        stride = max(1, n // 2000)
        for i in range(0, n, stride):
            v = filtered[i]
            if not self._threshold_initialized:
                self._ema_high = v
                self._ema_low = v
                self._threshold_initialized = True
            if v > self._ema_high:
                self._ema_high += ema_a * (v - self._ema_high)
            else:
                self._ema_high -= ema_a * 0.1 * (self._ema_high - v)
            if v < self._ema_low:
                self._ema_low += ema_a * (v - self._ema_low)
            else:
                self._ema_low += ema_a * 0.1 * (v - self._ema_low)
        self._threshold = (self._ema_high + self._ema_low) / 2

        # Modulation depth check
        mod_depth = self._ema_high - self._ema_low
        min_mod_depth = self._ema_high * 0.15
        signal_present = self._threshold_initialized and mod_depth > min_mod_depth and mod_depth > 0.005

        # Binary signal (vectorized)
        if signal_present:
            binary = (filtered >= self._threshold).astype(np.int8)
        else:
            binary = np.zeros(n, dtype=np.int8)

        # Prepend previous binary for edge detection
        full_binary = np.empty(n + 1, dtype=np.int8)
        full_binary[0] = self._prev_binary
        full_binary[1:] = binary

        # Find edges (vectorized)
        edges = np.diff(full_binary)
        edge_indices = np.nonzero(edges)[0]

        # Process edges through state machine
        for idx in edge_indices:
            is_rising = edges[idx] > 0
            global_pos = self._global_sample_offset + idx
            duration = global_pos - self._last_edge_offset

            if is_rising:
                self._on_rising_edge(global_pos, duration)
            else:
                self._on_falling_edge(global_pos, duration)

            self._last_edge_offset = global_pos

        # CW timeout check at end of chunk
        if self._state == self.DECODING_BITS and self._cw_timeout > 0 and n > 0:
            if binary[-1] == 1:
                cw_duration = (self._global_sample_offset + n - 1) - self._last_edge_offset
                if cw_duration > self._cw_timeout:
                    self._finish_command()

        if n > 0:
            self._prev_binary = int(binary[-1])
        self._global_sample_offset += n
        return self._messages

    def _samples_to_us(self, samples):
        return (samples / self.sample_rate) * 1e6

    def _on_falling_edge(self, pos, high_duration):
        if self._state == self.IDLE:
            self._state = self.WAIT_DELIMITER
            self._symbol_start = pos

        elif self._state == self.WAIT_DELIMITER:
            self._symbol_start = pos

        elif self._state == self.WAIT_DATA0:
            self._state = self.WAIT_RTCAL
            self._symbol_start = pos

        elif self._state == self.WAIT_RTCAL:
            duration = pos - self._symbol_start
            duration_us = self._samples_to_us(duration)
            if self._tari == 0:
                if self._tari_min_us <= duration_us <= self._tari_max_us:
                    self._tari = duration
                    self._symbol_start = pos
                else:
                    self._reset_preamble()
            else:
                tari_us = self._samples_to_us(self._tari)
                rtcal_us = self._samples_to_us(duration)
                if rtcal_us > tari_us * 1.5 and rtcal_us < tari_us * 8:
                    self._rtcal = duration
                    self._pivot = duration / 2
                    self._cw_timeout = self._rtcal * 3
                    self._bits = []
                    self._symbol_start = pos
                    self._state = self.DECODING_BITS
                    self.stats["preambles_seen"] += 1
                else:
                    self._reset_preamble()

        elif self._state == self.DECODING_BITS:
            symbol_duration = pos - self._symbol_start
            if self._pivot > 0:
                self._bits.append(1 if symbol_duration >= self._pivot else 0)
            self._symbol_start = pos
            if len(self._bits) > 512:
                self._finish_command()

    def _on_rising_edge(self, pos, low_duration):
        low_us = self._samples_to_us(low_duration)

        if self._state == self.WAIT_DELIMITER:
            if self._delimiter_min_us <= low_us <= self._delimiter_max_us:
                self._state = self.WAIT_DATA0
            elif low_us > self._delimiter_max_us:
                self._state = self.IDLE

    def _reset_preamble(self):
        self._state = self.IDLE
        self._tari = 0
        self._rtcal = 0
        self._pivot = 0
        self._bits = []

    def _finish_command(self):
        if len(self._bits) >= 2:
            result = parse_gen2_command(self._bits)
            if result:
                self._emit_message(result)
        self._reset_preamble()

    def _emit_message(self, parsed):
        is_new_round = parsed["command"] in ("Query", "QueryX", "QueryY")
        is_select = parsed["command"] == "Select"

        if is_new_round:
            self._round_id += 1
            self._pending_select_round_id = None
        if is_select and not is_new_round:
            self._pending_select_round_id = self._round_id + 1

        round_id = (self._pending_select_round_id
                     if is_select and self._pending_select_round_id is not None
                     else self._round_id)

        self._msg_id += 1
        msg = {
            "type": "decode",
            "id": self._msg_id,
            "direction": "R2T",
            "command": parsed["command"],
            "roundId": round_id,
            "freq": self.center_freq_mhz,
            "params": parsed["params"],
            "tagEpc": None,
            "crcValid": parsed["crcValid"],
        }

        self.stats["commands_decoded"] += 1
        if parsed["crcValid"] is False:
            self.stats["crc_errors"] += 1

        self._messages.append(msg)


# ===========================================================================
# Mock RFID Decoder — Generates realistic Gen2 command sequences
# ===========================================================================

MOCK_TAG_POOL = [
    {"epc": "E200 3411 B802 0115 2690 2154", "pc": "3000", "tid": "E200 3411 B802 0115", "killPwd": "00000000", "accessPwd": "00000000", "user": "0000 0000 0000 0000", "mfg": "Impinj Monza R6"},
    {"epc": "E200 6811 9504 0074 2780 4F21", "pc": "3000", "tid": "E200 6811 9504 0074", "killPwd": "00000000", "accessPwd": "00000000", "user": "0000 0000 0000 0000", "mfg": "Impinj Monza R6-P"},
    {"epc": "3034 0242 8C2A 0052 0000 040C", "pc": "3000", "tid": "E001 1302 B014 2210", "killPwd": "00000000", "accessPwd": "DEADBEEF", "user": "CAFE BABE 1234 5678", "mfg": "NXP UCODE 8"},
    {"epc": "3034 0242 8C2A 0052 0000 040D", "pc": "3000", "tid": "E001 1302 B014 2211", "killPwd": "00000000", "accessPwd": "A5A5A5A5", "user": "DEAD BEEF 0000 0000", "mfg": "NXP UCODE 8m"},
    {"epc": "E280 1160 2000 0209 6496 2436", "pc": "3400", "tid": "E280 1160 2000 0209", "killPwd": "00000000", "accessPwd": "00000000", "user": "0000 0000 0000 0000", "mfg": "Impinj M730"},
    {"epc": "E280 1194 2000 0071 2F18 1A56", "pc": "3400", "tid": "E280 1194 2000 0071", "killPwd": "00000000", "accessPwd": "12345678", "user": "4865 6C6C 6F21 0000", "mfg": "Impinj M750"},
    {"epc": "AD00 0000 0000 0000 0000 0001", "pc": "3000", "tid": "AD10 0010 0000 0001", "killPwd": "FFFFFFFF", "accessPwd": "FFFFFFFF", "user": "5465 7374 4461 7461", "mfg": "Impinj M800"},
    {"epc": "AD00 0000 0000 0000 0000 0002", "pc": "3000", "tid": "AD10 0010 0000 0002", "killPwd": "00000000", "accessPwd": "00000000", "user": "576F 726C 6421 0000", "mfg": "Impinj M800"},
]

FHSS_CHANNELS = [
    902.75, 904.25, 905.75, 907.25, 908.75, 910.25,
    911.75, 913.25, 915.00, 916.50, 918.00, 919.50,
    921.00, 922.50, 924.00, 925.50, 927.00,
]


def _rhex(length):
    return "".join(random.choice("0123456789ABCDEF") for _ in range(length))

def _rn16():
    return _rhex(4)

def _pick_ch():
    return random.choice(FHSS_CHANNELS)

def _pick_tags(n):
    pool = MOCK_TAG_POOL[:]
    random.shuffle(pool)
    return pool[:min(n, len(pool))]

def _wpick(items, weights):
    total = sum(weights)
    r = random.random() * total
    for item, w in zip(items, weights):
        r -= w
        if r <= 0:
            return item
    return items[-1]


class MockRFIDDecoder:
    """Generates realistic simulated EPC Gen2 command sequences."""

    def __init__(self):
        self._round_id = 0
        self._round_counter = 0
        self._mode = "mixed"
        self._msg_id = 0
        self.enabled = True

    @property
    def mode(self):
        return self._mode

    @mode.setter
    def mode(self, value):
        self._mode = value

    def generate_round(self):
        """Generate one round of mock commands. Returns list of (delay_ms, msg_dict)."""
        if self._mode == "reader-only":
            return self._gen_reader_only()
        elif self._mode == "inventory":
            return self._gen_inventory()
        elif self._mode == "access":
            return self._gen_access()
        elif self._mode == "security":
            return self._gen_security()
        elif self._mode == "gen2x":
            return self._gen_gen2x()
        else:  # mixed
            r = self._round_counter
            if r > 0 and r % random.randint(8, 11) == 0:
                return self._gen_gen2x()
            elif r > 0 and r % random.randint(10, 14) == 0:
                return self._gen_security()
            elif r > 0 and r % random.randint(5, 7) == 0:
                return self._gen_access()
            else:
                return self._gen_inventory()

    def _next_id(self):
        self._msg_id += 1
        return self._msg_id

    def _msg(self, direction, command, round_id, freq, params, tag_epc=None):
        return {
            "type": "decode",
            "id": self._next_id(),
            "direction": direction,
            "command": command,
            "roundId": round_id,
            "freq": freq,
            "params": params,
            "tagEpc": tag_epc,
        }

    def _gen_inventory(self):
        self._round_id += 1
        freq = _pick_ch()
        q = random.randint(2, 5)
        num_tags = random.randint(1, 3)
        tags = _pick_tags(num_tags)
        session = random.choice(["S0", "S1"])
        m = random.choice(["FM0", "Miller2", "Miller4", "Miller8"])
        d = 0
        msgs = []

        if self._round_counter % random.randint(3, 5) == 0:
            mask_tag = tags[0]
            msgs.append((d, self._msg("R2T", "Select", self._round_id, freq, {
                "target": session, "action": "A0", "memBank": "EPC", "pointer": 32,
                "length": 96, "mask": mask_tag["epc"].replace(" ", "")[:12] + "...", "truncate": False,
            })))
            d += 4 + random.random() * 4

        msgs.append((d, self._msg("R2T", "Query", self._round_id, freq, {
            "DR": "8", "M": m, "TRext": False, "Sel": "All", "session": session, "target": "A", "Q": q,
        })))
        d += 2 + random.random() * 2

        for ti, tag in enumerate(tags):
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1 + random.random() * 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 1.5 + random.random() * 2
            msgs.append((d, self._msg("T2R", "EPC", self._round_id, freq,
                {"pc": tag["pc"], "epc": tag["epc"], "crc": _rhex(4)}, tag["epc"])))
            d += 1 + random.random() * 2
            if ti < len(tags) - 1:
                msgs.append((d, self._msg("R2T", "QueryRep", self._round_id, freq, {"session": session})))
                d += 1.5 + random.random() * 1.5

        msgs.append((d, self._msg("R2T", "QueryRep", self._round_id, freq, {"session": session})))
        self._round_counter += 1
        return msgs

    def _gen_access(self):
        self._round_id += 1
        freq = _pick_ch()
        tag = random.choice(MOCK_TAG_POOL)
        r = _rn16()
        handle = _rn16()
        d = 0
        msgs = []

        msgs.append((d, self._msg("R2T", "ReqRN", self._round_id, freq, {"rn16": r}, tag["epc"])))
        d += 2
        msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        d += 2

        op = _wpick(["Read", "Write", "Kill", "Lock", "BlockWrite", "BlockErase"],
                     [0.40, 0.25, 0.05, 0.10, 0.12, 0.08])

        if op == "Read":
            bank = random.choice(["Reserved", "EPC", "TID", "User"])
            wc = 4 if bank == "TID" else (2 if bank == "Reserved" else 6)
            msgs.append((d, self._msg("R2T", "Read", self._round_id, freq,
                {"memBank": bank, "wordPtr": 0, "wordCount": wc}, tag["epc"])))
            d += 3
            data = {"TID": tag["tid"], "User": tag["user"], "Reserved": tag["killPwd"] + " " + tag["accessPwd"]}.get(bank, tag["epc"])
            msgs.append((d, self._msg("T2R", "Data", self._round_id, freq,
                {"memBank": bank, "words": data}, tag["epc"])))
        elif op == "Write":
            msgs.append((d, self._msg("R2T", "Write", self._round_id, freq,
                {"memBank": "User", "wordPtr": 0, "data": _rhex(4)}, tag["epc"])))
            d += 5
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "Kill":
            msgs.append((d, self._msg("R2T", "Kill", self._round_id, freq,
                {"password": tag["killPwd"][:8], "phase": "first"}, tag["epc"])))
            d += 3
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
            d += 2
            msgs.append((d, self._msg("R2T", "Kill", self._round_id, freq,
                {"password": tag["killPwd"][:8], "phase": "second"}, tag["epc"])))
            d += 3
            if random.random() > 0.3:
                msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "Lock":
            payload = _rhex(5).upper()
            msgs.append((d, self._msg("R2T", "Lock", self._round_id, freq,
                {"payload": payload, "action": "permalock-user"}, tag["epc"])))
            d += 3
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "BlockWrite":
            msgs.append((d, self._msg("R2T", "BlockWrite", self._round_id, freq,
                {"memBank": "User", "wordPtr": 0, "wordCount": 4, "data": _rhex(16)}, tag["epc"])))
            d += 6
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "BlockErase":
            msgs.append((d, self._msg("R2T", "BlockErase", self._round_id, freq,
                {"memBank": "User", "wordPtr": 0, "wordCount": 4}, tag["epc"])))
            d += 5
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))

        self._round_counter += 1
        return msgs

    def _gen_security(self):
        self._round_id += 1
        freq = _pick_ch()
        tag = random.choice(MOCK_TAG_POOL)
        handle = _rn16()
        d = 0
        msgs = []

        op = _wpick(["Authenticate", "Challenge", "Untraceable", "FileOpen", "TagPrivilege"],
                     [0.35, 0.25, 0.20, 0.10, 0.10])

        if op == "Authenticate":
            mode = random.choice(["TAM1", "TAM2"])
            msgs.append((d, self._msg("R2T", "Authenticate", self._round_id, freq,
                {"CSI": "AES-128", "mode": mode, "keyID": 0, "challenge": _rhex(32), "msgLen": 128}, tag["epc"])))
            d += 8
            reply = {"response": _rhex(32), "CMAC": _rhex(8)}
            if mode == "TAM2":
                reply["data"] = tag["tid"]
            msgs.append((d, self._msg("T2R", "AuthReply", self._round_id, freq, reply, tag["epc"])))
        elif op == "Challenge":
            msgs.append((d, self._msg("R2T", "Challenge", self._round_id, freq,
                {"CSI": "AES-128", "message": _rhex(16)}, tag["epc"])))
            d += 5
            msgs.append((d, self._msg("T2R", "ChallengeReply", self._round_id, freq,
                {"tagNonce": _rhex(16)}, tag["epc"])))
        elif op == "Untraceable":
            msgs.append((d, self._msg("R2T", "Untraceable", self._round_id, freq, {
                "setU": True, "epcWordLen": 6, "hideEPC": "show-all", "hideUser": False,
                "tidPolicy": "show-all", "rangePolicy": "normal", "rxAttn": False,
            }, tag["epc"])))
            d += 4
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "FileOpen":
            msgs.append((d, self._msg("R2T", "FileOpen", self._round_id, freq,
                {"fileNum": random.randint(0, 3)}, tag["epc"])))
            d += 3
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))
        elif op == "TagPrivilege":
            msgs.append((d, self._msg("R2T", "TagPrivilege", self._round_id, freq, {}, tag["epc"])))
            d += 3
            msgs.append((d, self._msg("T2R", "Handle", self._round_id, freq, {"handle": handle}, tag["epc"])))

        self._round_counter += 1
        return msgs

    def _gen_gen2x(self):
        self._round_id += 1
        freq = _pick_ch()
        tag = random.choice(MOCK_TAG_POOL)
        handle = _rn16()
        d = 0
        msgs = []

        op = _wpick(
            ["FastID", "TagFocus", "ProtectedMode", "QueryX", "QueryY", "ReadVar", "Authenticity", "Integra"],
            [0.20, 0.15, 0.12, 0.15, 0.08, 0.12, 0.10, 0.08],
        )

        if op == "FastID":
            msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                {"target": "SL", "action": "A0", "memBank": "TID", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] FastID enable"})))
            d += 3
            q = random.randint(2, 4)
            msgs.append((d, self._msg("R2T", "Query", self._round_id, freq,
                {"DR": "8", "M": "FM0", "TRext": False, "Sel": "SL", "session": "S0", "target": "A", "Q": q})))
            d += 2
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 2
            msgs.append((d, self._msg("T2R", "XPC_EPC", self._round_id, freq,
                {"pc": tag["pc"], "xpc_w1": _rhex(4), "xpc_w2": _rhex(4), "epc": tag["epc"], "tid": tag["tid"], "crc": _rhex(4)}, tag["epc"])))

        elif op == "TagFocus":
            msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                {"target": "S1", "action": "A5", "memBank": "EPC", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] TagFocus enable"})))
            d += 3
            msgs.append((d, self._msg("R2T", "Query", self._round_id, freq,
                {"DR": "8", "M": "FM0", "TRext": False, "Sel": "All", "session": "S1", "target": "A", "Q": 3})))
            d += 2
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 2
            msgs.append((d, self._msg("T2R", "EPC", self._round_id, freq,
                {"pc": tag["pc"], "epc": tag["epc"], "crc": _rhex(4), "note": "TagFocus: new tag only"}, tag["epc"])))

        elif op == "ProtectedMode":
            msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                {"target": "SL", "action": "A0", "memBank": "EPC", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] Protected Mode unlock"})))
            d += 3
            msgs.append((d, self._msg("R2T", "Query", self._round_id, freq,
                {"DR": "8", "M": "FM0", "TRext": False, "Sel": "SL", "session": "S0", "target": "A", "Q": 2})))
            d += 2
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 2
            msgs.append((d, self._msg("T2R", "EPC", self._round_id, freq,
                {"pc": tag["pc"], "epc": tag["epc"], "crc": _rhex(4), "note": "unlocked via PIN"}, tag["epc"])))

        elif op == "QueryX":
            msgs.append((d, self._msg("R2T", "QueryX", self._round_id, freq, {
                "ackData": "EPC+TID", "replyCRC": True, "session": "S0", "target": "A", "Q": 3,
                "memBank": "EPC", "pointer": 32, "compare": "=", "mask": tag["epc"].replace(" ", "")[:8] + "...",
            })))
            d += 3
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 2
            msgs.append((d, self._msg("T2R", "EPC", self._round_id, freq,
                {"pc": tag["pc"], "epc": tag["epc"], "tid": tag["tid"], "crc": _rhex(4)}, tag["epc"])))

        elif op == "QueryY":
            msgs.append((d, self._msg("R2T", "QueryY", self._round_id, freq,
                {"ackData": "EPC", "replyCRC": True, "session": "S0", "target": "A", "Q": 4, "filterMode": "inclusive"})))
            d += 3
            r = _rn16()
            msgs.append((d, self._msg("T2R", "RN16", self._round_id, freq, {"rn16": r})))
            d += 1.5
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": r})))
            d += 2
            msgs.append((d, self._msg("T2R", "EPC", self._round_id, freq,
                {"pc": tag["pc"], "epc": tag["epc"], "crc": _rhex(4)}, tag["epc"])))

        elif op == "ReadVar":
            msgs.append((d, self._msg("R2T", "ReadVar", self._round_id, freq,
                {"memBank": "User", "wordPtr": 0}, tag["epc"])))
            d += 4
            nw = random.randint(4, 7)
            msgs.append((d, self._msg("T2R", "DataVar", self._round_id, freq,
                {"memBank": "User", "words": tag["user"], "numWords": nw, "moreWords": 0, "parity": True}, tag["epc"])))

        elif op == "Authenticity":
            msgs.append((d, self._msg("R2T", "Authenticate", self._round_id, freq,
                {"CSI": "AES-128", "mode": "TAM1", "keyID": 0, "challenge": _rhex(32), "msgLen": 128, "note": "[Gen2X] Authenticity"}, tag["epc"])))
            d += 8
            msgs.append((d, self._msg("T2R", "AuthReply", self._round_id, freq,
                {"response": _rhex(32), "CMAC": _rhex(8), "valid": random.random() > 0.1}, tag["epc"])))

        elif op == "Integra":
            msgs.append((d, self._msg("R2T", "Read", self._round_id, freq,
                {"memBank": "TID", "wordPtr": 0, "wordCount": 8, "note": "[Gen2X] Integra diagnostic"}, tag["epc"])))
            d += 5
            msgs.append((d, self._msg("T2R", "Data", self._round_id, freq,
                {"memBank": "TID", "words": tag["tid"] + " " + _rhex(8), "note": "Integra: chip healthy"}, tag["epc"])))

        self._round_counter += 1
        return msgs

    def _gen_reader_only(self):
        self._round_id += 1
        freq = _pick_ch()
        q = random.randint(2, 5)
        session = random.choice(["S0", "S1"])
        m = random.choice(["FM0", "Miller2", "Miller4", "Miller8"])
        d = 0
        msgs = []

        # Occasionally start with Select
        if self._round_counter % random.randint(2, 4) == 0:
            tag = random.choice(MOCK_TAG_POOL)
            sel_op = _wpick(["select-epc", "select-tid", "fastid", "tagfocus", "protected"],
                            [0.40, 0.15, 0.15, 0.15, 0.15])
            if sel_op == "fastid":
                msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                    {"target": "SL", "action": "A0", "memBank": "TID", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] FastID enable"})))
            elif sel_op == "tagfocus":
                msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                    {"target": "S1", "action": "A5", "memBank": "EPC", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] TagFocus enable"})))
            elif sel_op == "protected":
                msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                    {"target": "SL", "action": "A0", "memBank": "EPC", "pointer": 0, "length": 0, "mask": "", "note": "[Gen2X] Protected Mode unlock"})))
            elif sel_op == "select-tid":
                msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                    {"target": session, "action": "A0", "memBank": "TID", "pointer": 0, "length": 32, "mask": tag["tid"].replace(" ", "")[:8] + "..."})))
            else:
                msgs.append((d, self._msg("R2T", "Select", self._round_id, freq,
                    {"target": session, "action": "A0", "memBank": "EPC", "pointer": 32, "length": 96, "mask": tag["epc"].replace(" ", "")[:12] + "..."})))
            d += 3 + random.random() * 3

        # Query
        query_type = _wpick(["Query", "QueryX", "QueryY"], [0.75, 0.18, 0.07])
        if query_type == "QueryX":
            tag = random.choice(MOCK_TAG_POOL)
            msgs.append((d, self._msg("R2T", "QueryX", self._round_id, freq, {
                "ackData": "EPC+TID", "replyCRC": True, "session": session, "target": "A", "Q": q,
                "memBank": "EPC", "pointer": 32, "compare": "=", "mask": tag["epc"].replace(" ", "")[:8] + "...",
            })))
        elif query_type == "QueryY":
            msgs.append((d, self._msg("R2T", "QueryY", self._round_id, freq,
                {"ackData": "EPC", "replyCRC": True, "session": session, "target": "A", "Q": q, "filterMode": "inclusive"})))
        else:
            msgs.append((d, self._msg("R2T", "Query", self._round_id, freq,
                {"DR": "8", "M": m, "TRext": False, "Sel": "All", "session": session, "target": "A", "Q": q})))
        d += 2 + random.random() * 2

        # Slots
        num_slots = random.randint(1, 4)
        for i in range(num_slots):
            msgs.append((d, self._msg("R2T", "ACK", self._round_id, freq, {"rn16": _rn16()})))
            d += 2 + random.random() * 3

            if random.random() < 0.25:
                access_op = _wpick(
                    ["ReqRN", "Read", "Write", "Lock", "Kill", "Authenticate", "Challenge", "Untraceable"],
                    [0.25, 0.30, 0.15, 0.08, 0.02, 0.10, 0.05, 0.05],
                )
                if access_op == "ReqRN":
                    msgs.append((d, self._msg("R2T", "ReqRN", self._round_id, freq, {"rn16": _rn16()})))
                    d += 2 + random.random() * 2
                    if random.random() < 0.6:
                        bank = random.choice(["Reserved", "EPC", "TID", "User"])
                        wc = 4 if bank == "TID" else (2 if bank == "Reserved" else 6)
                        msgs.append((d, self._msg("R2T", "Read", self._round_id, freq,
                            {"memBank": bank, "wordPtr": 0, "wordCount": wc})))
                        d += 3 + random.random() * 2
                elif access_op == "Read":
                    bank = random.choice(["Reserved", "EPC", "TID", "User"])
                    wc = 4 if bank == "TID" else (2 if bank == "Reserved" else 6)
                    msgs.append((d, self._msg("R2T", "Read", self._round_id, freq,
                        {"memBank": bank, "wordPtr": 0, "wordCount": wc})))
                    d += 3 + random.random() * 2
                elif access_op == "Write":
                    msgs.append((d, self._msg("R2T", "Write", self._round_id, freq,
                        {"memBank": "User", "wordPtr": 0, "data": _rhex(4)})))
                    d += 4 + random.random() * 2
                elif access_op == "Lock":
                    msgs.append((d, self._msg("R2T", "Lock", self._round_id, freq,
                        {"payload": _rhex(5).upper(), "action": "permalock-user"})))
                    d += 3
                elif access_op == "Kill":
                    msgs.append((d, self._msg("R2T", "Kill", self._round_id, freq,
                        {"password": _rhex(8), "phase": "first"})))
                    d += 3
                elif access_op == "Authenticate":
                    msgs.append((d, self._msg("R2T", "Authenticate", self._round_id, freq,
                        {"CSI": "AES-128", "mode": random.choice(["TAM1", "TAM2"]), "keyID": 0, "challenge": _rhex(32), "msgLen": 128})))
                    d += 6 + random.random() * 3
                elif access_op == "Challenge":
                    msgs.append((d, self._msg("R2T", "Challenge", self._round_id, freq,
                        {"CSI": "AES-128", "message": _rhex(16)})))
                    d += 4 + random.random() * 2
                elif access_op == "Untraceable":
                    msgs.append((d, self._msg("R2T", "Untraceable", self._round_id, freq, {
                        "setU": True, "epcWordLen": 6, "hideEPC": "show-all",
                        "hideUser": False, "tidPolicy": "show-all", "rangePolicy": "normal",
                    })))
                    d += 3 + random.random() * 2

            if i < num_slots - 1:
                msgs.append((d, self._msg("R2T", "QueryRep", self._round_id, freq, {"session": session})))
                d += 1.5 + random.random() * 2

        msgs.append((d, self._msg("R2T", "QueryRep", self._round_id, freq, {"session": session})))
        self._round_counter += 1
        return msgs


# ===========================================================================
# Spectrum Analyzers
# ===========================================================================

class SpectrumAnalyzer:
    """Wraps the RTL-SDR device and produces FFT magnitude arrays."""

    def __init__(self, center_freq=DEFAULT_CENTER_FREQ,
                 sample_rate=DEFAULT_SAMPLE_RATE,
                 gain=DEFAULT_GAIN,
                 fft_size=DEFAULT_FFT_SIZE,
                 device_index=0):
        self.center_freq = center_freq
        self.sample_rate = sample_rate
        self.gain = gain
        self.fft_size = fft_size
        self.device_index = device_index
        self.sdr = None
        self.running = False
        self.avg_buffer = None
        self.avg_alpha = 0.3
        self.peak_hold = None
        self.window = blackmanharris(self.fft_size)

    def open(self):
        if not HAS_RTLSDR:
            raise RuntimeError("pyrtlsdr is not installed")
        self.sdr = RtlSdr(self.device_index)
        self.sdr.center_freq = self.center_freq
        self.sdr.sample_rate = self.sample_rate
        self.sdr.gain = self.gain
        self.running = True
        log.info("RTL-SDR opened  fc=%.3f MHz  fs=%.3f MHz  gain=%s dB",
                 self.center_freq / 1e6, self.sample_rate / 1e6, self.gain)

    def close(self):
        self.running = False
        if self.sdr is not None:
            self.sdr.close()
            self.sdr = None
            log.info("RTL-SDR closed")

    def set_center_freq(self, freq):
        self.center_freq = freq
        if self.sdr:
            self.sdr.center_freq = freq

    def set_gain(self, gain):
        self.gain = gain
        if self.sdr:
            self.sdr.gain = gain

    def set_sample_rate(self, rate):
        self.sample_rate = rate
        if self.sdr:
            self.sdr.sample_rate = rate
        self.window = blackmanharris(self.fft_size)

    def set_fft_size(self, size):
        self.fft_size = size
        self.window = blackmanharris(self.fft_size)
        self.avg_buffer = None
        self.peak_hold = None

    def read_spectrum(self):
        if self.sdr is None:
            raise RuntimeError("SDR not open")
        samples = self.sdr.read_samples(self.fft_size)
        return self._compute_fft(samples), samples

    def read_raw(self, count):
        """Read raw IQ samples for decode. Returns complex numpy array."""
        if self.sdr is None:
            raise RuntimeError("SDR not open")
        return self.sdr.read_samples(count)

    def _compute_fft(self, samples):
        n = self.fft_size
        iq = np.array(samples[:n])
        windowed = iq * self.window
        spectrum = np.fft.fftshift(np.fft.fft(windowed, n))
        magnitude = np.abs(spectrum)
        magnitude[magnitude == 0] = 1e-15
        psd_db = 20.0 * np.log10(magnitude) - 10.0 * np.log10(n)

        if self.avg_buffer is None or len(self.avg_buffer) != n:
            self.avg_buffer = psd_db.copy()
        else:
            self.avg_buffer = self.avg_alpha * psd_db + (1 - self.avg_alpha) * self.avg_buffer

        if self.peak_hold is None or len(self.peak_hold) != n:
            self.peak_hold = psd_db.copy()
        else:
            self.peak_hold = np.maximum(self.peak_hold, psd_db)

        freqs = np.linspace(
            (self.center_freq - self.sample_rate / 2) / 1e6,
            (self.center_freq + self.sample_rate / 2) / 1e6,
            n,
        )
        return freqs, psd_db, self.avg_buffer, self.peak_hold

    def reset_peak_hold(self):
        self.peak_hold = None


class SimulatedAnalyzer(SpectrumAnalyzer):
    """Generates synthetic UHF RFID-like signals for demo/dev."""

    def open(self):
        self.running = True
        log.info("Simulated SDR opened  fc=%.3f MHz  fs=%.3f MHz",
                 self.center_freq / 1e6, self.sample_rate / 1e6)

    def close(self):
        self.running = False
        log.info("Simulated SDR closed")

    def read_spectrum(self):
        n = self.fft_size
        t = time.time()
        noise = np.random.normal(0, 0.005, n) + 1j * np.random.normal(0, 0.005, n)
        fs = self.sample_rate
        fc = self.center_freq
        lo = fc - fs / 2
        hi = fc + fs / 2
        tag_freqs = [902.75e6, 910.0e6, 915.25e6, 920.0e6, 926.0e6]

        for f in tag_freqs:
            if lo <= f <= hi:
                amp = 0.08 + 0.06 * np.sin(2 * np.pi * 0.3 * t + f / 1e6)
                offset = (f - fc) / fs
                phase = np.exp(2j * np.pi * offset * np.arange(n))
                noise += amp * phase

        reader_center = 915e6
        if lo <= reader_center <= hi:
            bw = 500e3
            center_bin = int((reader_center - lo) / fs * n)
            spread = int(bw / fs * n / 2)
            for i in range(max(0, center_bin - spread), min(n, center_bin + spread)):
                bump = 0.12 * np.exp(-0.5 * ((i - center_bin) / (spread / 2.5)) ** 2)
                bump *= (1 + 0.3 * np.sin(2 * np.pi * 1.7 * t))
                noise[i] += bump

        return self._compute_fft(noise), None  # no raw IQ for simulated


# ===========================================================================
# Device Enumeration
# ===========================================================================

def enumerate_devices():
    """List available RTL-SDR devices + simulated device."""
    devices = []

    if HAS_RTLSDR:
        try:
            lib_path = ctypes.util.find_library("rtlsdr")
            if not lib_path:
                for path in ["/opt/homebrew/lib/librtlsdr.dylib",
                             "/opt/homebrew/lib/librtlsdr.so",
                             "/usr/lib/librtlsdr.so",
                             "/usr/lib/x86_64-linux-gnu/librtlsdr.so"]:
                    if os.path.exists(path):
                        lib_path = path
                        break

            if lib_path:
                lib = ctypes.CDLL(lib_path)
                count = lib.rtlsdr_get_device_count()
                lib.rtlsdr_get_device_name.restype = ctypes.c_char_p

                for i in range(count):
                    name = lib.rtlsdr_get_device_name(i)
                    name = name.decode("utf-8") if name else f"RTL-SDR #{i}"
                    manufact = ctypes.create_string_buffer(256)
                    product = ctypes.create_string_buffer(256)
                    serial = ctypes.create_string_buffer(256)
                    lib.rtlsdr_get_device_usb_strings(i, manufact, product, serial)
                    serial_str = serial.value.decode("utf-8", errors="replace")
                    devices.append({"index": i, "name": name, "serial": serial_str})
            else:
                log.warning("librtlsdr not found for device enumeration")
        except Exception as e:
            log.warning("Device enumeration failed: %s", e)

    devices.append({"index": -1, "name": "Simulated RTL-SDR", "serial": "SIM"})
    return devices

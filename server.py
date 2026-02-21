#!/usr/bin/env python3
"""
UHF RFID Spectrum Analyzer — RTL-SDR Backend

Streams FFT data over WebSocket to the browser-based UI.
Designed for monitoring UHF RFID bands (860–960 MHz).
"""

import argparse
import asyncio
import json
import logging
import os
import struct
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import numpy as np

try:
    from rtlsdr import RtlSdr
    HAS_RTLSDR = True
except ImportError:
    HAS_RTLSDR = False

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rfid-spectrum")

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_CENTER_FREQ = 915e6      # 915 MHz — US UHF RFID center
DEFAULT_SAMPLE_RATE = 2.4e6      # 2.4 MSPS
DEFAULT_GAIN = 40                # dB
DEFAULT_FFT_SIZE = 1024
DEFAULT_WS_PORT = 8765
DEFAULT_HTTP_PORT = 8080

# UHF RFID regional band definitions (MHz)
RFID_BANDS = {
    "FCC (US)":       {"start": 902.0, "end": 928.0, "channels": 50, "power": "1W ERP"},
    "ETSI (EU)":      {"start": 865.6, "end": 867.6, "channels": 4,  "power": "2W ERP"},
    "China":          {"start": 920.0, "end": 925.0, "channels": 16, "power": "2W ERP"},
    "Japan":          {"start": 916.8, "end": 920.4, "channels": 9,  "power": "250mW"},
    "Korea":          {"start": 917.0, "end": 923.5, "channels": 13, "power": "200mW"},
    "Brazil":         {"start": 902.0, "end": 907.5, "channels": 11, "power": "4W EIRP"},
    "Australia":      {"start": 920.0, "end": 926.0, "channels": 12, "power": "1W EIRP"},
}


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

        # Averaging / peak-hold state
        self.avg_buffer = None
        self.avg_alpha = 0.3          # EMA smoothing factor
        self.peak_hold = None

        # Window function (pre-computed)
        self.window = np.blackmanharris(self.fft_size)

    # ----- device control -----

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
        self.window = np.blackmanharris(self.fft_size)

    def set_fft_size(self, size):
        self.fft_size = size
        self.window = np.blackmanharris(self.fft_size)
        self.avg_buffer = None
        self.peak_hold = None

    # ----- DSP -----

    def read_spectrum(self):
        """Read samples from the SDR and return (freqs_mhz, magnitudes_db)."""
        if self.sdr is None:
            raise RuntimeError("SDR not open")

        samples = self.sdr.read_samples(self.fft_size)
        return self._compute_fft(samples)

    def _compute_fft(self, samples):
        """Compute power spectral density from IQ samples."""
        n = self.fft_size
        iq = np.array(samples[:n])

        # Apply window
        windowed = iq * self.window

        # FFT → shift DC to center
        spectrum = np.fft.fftshift(np.fft.fft(windowed, n))

        # Power in dB (avoid log10(0))
        magnitude = np.abs(spectrum)
        magnitude[magnitude == 0] = 1e-15
        psd_db = 20.0 * np.log10(magnitude) - 10.0 * np.log10(n)

        # Exponential moving average
        if self.avg_buffer is None or len(self.avg_buffer) != n:
            self.avg_buffer = psd_db.copy()
        else:
            self.avg_buffer = self.avg_alpha * psd_db + (1 - self.avg_alpha) * self.avg_buffer

        # Peak hold
        if self.peak_hold is None or len(self.peak_hold) != n:
            self.peak_hold = psd_db.copy()
        else:
            self.peak_hold = np.maximum(self.peak_hold, psd_db)

        # Frequency axis
        freqs = np.linspace(
            (self.center_freq - self.sample_rate / 2) / 1e6,
            (self.center_freq + self.sample_rate / 2) / 1e6,
            n,
        )

        return freqs, psd_db, self.avg_buffer, self.peak_hold

    def reset_peak_hold(self):
        self.peak_hold = None


class SimulatedAnalyzer(SpectrumAnalyzer):
    """Drop-in replacement that generates synthetic UHF RFID-like signals
    so the UI can be developed and demoed without real hardware."""

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

        # Noise floor ~ -90 dBm
        noise = np.random.normal(0, 0.005, n) + 1j * np.random.normal(0, 0.005, n)

        # Inject a few UHF RFID-like carriers within the visible window
        fs = self.sample_rate
        fc = self.center_freq
        lo = fc - fs / 2
        hi = fc + fs / 2
        tag_freqs = [902.75e6, 910.0e6, 915.25e6, 920.0e6, 926.0e6]

        for f in tag_freqs:
            if lo <= f <= hi:
                # Time-varying amplitude to simulate bursty tag responses
                amp = 0.08 + 0.06 * np.sin(2 * np.pi * 0.3 * t + f / 1e6)
                offset = (f - fc) / fs  # normalised offset in [-0.5, 0.5]
                phase = np.exp(2j * np.pi * offset * np.arange(n))
                noise += amp * phase

        # Broadband reader emission (wideband hump)
        reader_center = 915e6
        if lo <= reader_center <= hi:
            bw = 500e3  # 500 kHz wide
            center_bin = int((reader_center - lo) / fs * n)
            spread = int(bw / fs * n / 2)
            for i in range(max(0, center_bin - spread), min(n, center_bin + spread)):
                bump = 0.12 * np.exp(-0.5 * ((i - center_bin) / (spread / 2.5)) ** 2)
                bump *= (1 + 0.3 * np.sin(2 * np.pi * 1.7 * t))
                noise[i] += bump

        return self._compute_fft(noise)


# ---------------------------------------------------------------------------
# WebSocket server
# ---------------------------------------------------------------------------

connected_clients = set()


async def handler(ws):
    """Handle a single WebSocket client."""
    connected_clients.add(ws)
    log.info("Client connected (%d total)", len(connected_clients))
    try:
        async for msg in ws:
            # Clients can send JSON commands
            try:
                cmd = json.loads(msg)
                await process_command(cmd)
            except json.JSONDecodeError:
                pass
    finally:
        connected_clients.discard(ws)
        log.info("Client disconnected (%d total)", len(connected_clients))


analyzer: SpectrumAnalyzer = None  # set in main()


async def process_command(cmd):
    """Process a control command from the UI."""
    action = cmd.get("action")
    if action == "set_center_freq":
        analyzer.set_center_freq(float(cmd["value"]) * 1e6)
    elif action == "set_gain":
        analyzer.set_gain(float(cmd["value"]))
    elif action == "set_sample_rate":
        analyzer.set_sample_rate(float(cmd["value"]) * 1e6)
    elif action == "set_fft_size":
        analyzer.set_fft_size(int(cmd["value"]))
    elif action == "set_avg_alpha":
        analyzer.avg_alpha = float(cmd["value"])
    elif action == "reset_peak":
        analyzer.reset_peak_hold()
    elif action == "get_bands":
        # Send band definitions to newly-connected clients
        pass  # bands are sent with every frame


async def broadcast_loop(interval=0.05):
    """Read SDR data and push spectrum frames to all connected clients."""
    while analyzer.running:
        if connected_clients:
            try:
                freqs, live, avg, peak = analyzer.read_spectrum()
                payload = json.dumps({
                    "type": "spectrum",
                    "freqs": freqs.tolist(),
                    "live": live.tolist(),
                    "avg": avg.tolist(),
                    "peak": peak.tolist(),
                    "center_freq": analyzer.center_freq / 1e6,
                    "sample_rate": analyzer.sample_rate / 1e6,
                    "gain": analyzer.gain,
                    "fft_size": analyzer.fft_size,
                    "bands": RFID_BANDS,
                })
                coros = [c.send(payload) for c in connected_clients.copy()]
                await asyncio.gather(*coros, return_exceptions=True)
            except Exception as e:
                log.error("broadcast error: %s", e)
        await asyncio.sleep(interval)


# ---------------------------------------------------------------------------
# Lightweight HTTP server for the UI
# ---------------------------------------------------------------------------

def start_http_server(port, directory):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)
        def log_message(self, fmt, *args):
            pass  # silence request logs

    httpd = HTTPServer(("0.0.0.0", port), Handler)
    log.info("HTTP server on http://0.0.0.0:%d", port)
    httpd.serve_forever()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main(args):
    global analyzer

    if args.simulate or not HAS_RTLSDR:
        if not args.simulate and not HAS_RTLSDR:
            log.warning("pyrtlsdr not found — falling back to simulation mode")
        analyzer = SimulatedAnalyzer(
            center_freq=args.freq * 1e6,
            sample_rate=args.rate * 1e6,
            gain=args.gain,
            fft_size=args.fft,
        )
    else:
        analyzer = SpectrumAnalyzer(
            center_freq=args.freq * 1e6,
            sample_rate=args.rate * 1e6,
            gain=args.gain,
            fft_size=args.fft,
            device_index=args.device,
        )

    analyzer.open()

    # Start HTTP file server in a daemon thread
    ui_dir = str(Path(__file__).parent)
    http_thread = threading.Thread(target=start_http_server,
                                   args=(args.http_port, ui_dir),
                                   daemon=True)
    http_thread.start()

    # Start WebSocket server
    log.info("WebSocket server on ws://0.0.0.0:%d", args.ws_port)
    async with websockets.serve(handler, "0.0.0.0", args.ws_port):
        await broadcast_loop(interval=1.0 / args.fps)


def cli():
    p = argparse.ArgumentParser(description="UHF RFID Spectrum Analyzer (RTL-SDR)")
    p.add_argument("-f", "--freq",    type=float, default=915.0,
                   help="Center frequency in MHz (default: 915)")
    p.add_argument("-r", "--rate",    type=float, default=2.4,
                   help="Sample rate in MHz (default: 2.4)")
    p.add_argument("-g", "--gain",    type=float, default=40,
                   help="RF gain in dB (default: 40)")
    p.add_argument("-n", "--fft",     type=int,   default=1024,
                   help="FFT size (default: 1024)")
    p.add_argument("-d", "--device",  type=int,   default=0,
                   help="RTL-SDR device index (default: 0)")
    p.add_argument("--ws-port",      type=int,   default=DEFAULT_WS_PORT,
                   help=f"WebSocket port (default: {DEFAULT_WS_PORT})")
    p.add_argument("--http-port",    type=int,   default=DEFAULT_HTTP_PORT,
                   help=f"HTTP port (default: {DEFAULT_HTTP_PORT})")
    p.add_argument("--fps",          type=int,   default=20,
                   help="Target frames per second (default: 20)")
    p.add_argument("--simulate",     action="store_true",
                   help="Use simulated SDR data (no hardware required)")
    return p.parse_args()


if __name__ == "__main__":
    args = cli()
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        if analyzer:
            analyzer.close()

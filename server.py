#!/usr/bin/env python3
"""
UHF RFID Spectrum Analyzer — RTL-SDR Backend

Streams FFT spectrum + decoded RFID commands over WebSocket.
Handles device discovery, selection, and both real (PIE decode from IQ)
and simulated (mock Gen2 sequences) operating modes.
"""

import argparse
import asyncio
import json
import logging
import random
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

import websockets

from rfid_decoder import (
    RFID_BANDS,
    DEFAULT_CENTER_FREQ,
    DEFAULT_SAMPLE_RATE,
    DEFAULT_GAIN,
    DEFAULT_FFT_SIZE,
    PIEDecoder,
    MockRFIDDecoder,
    SpectrumAnalyzer,
    SimulatedAnalyzer,
    enumerate_devices,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rfid-spectrum")

# ---------------------------------------------------------------------------
# Defaults (server-specific)
# ---------------------------------------------------------------------------
DEFAULT_WS_PORT = 8765
DEFAULT_HTTP_PORT = 8080


# ===========================================================================
# WebSocket Server
# ===========================================================================

connected_clients = set()
analyzer = None
pie_decoder = None
mock_decoder = None
broadcast_task = None
decode_task = None
_cli_args = None  # stored from CLI for defaults


async def broadcast_to_clients(payload):
    """Send a JSON payload to all connected clients."""
    if not connected_clients:
        return
    msg = json.dumps(payload) if isinstance(payload, dict) else payload
    coros = [c.send(msg) for c in connected_clients.copy()]
    await asyncio.gather(*coros, return_exceptions=True)


async def spectrum_loop(fps=20):
    """Read SDR data and push spectrum frames to all connected clients."""
    interval = 1.0 / fps
    while analyzer and analyzer.running:
        if connected_clients:
            try:
                result = analyzer.read_spectrum()
                (freqs, live, avg, peak), raw_iq = result

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
                await broadcast_to_clients(payload)

                # Real-time PIE decode from raw IQ (hardware mode only)
                if pie_decoder and raw_iq is not None:
                    decoded = pie_decoder.process(raw_iq)
                    for msg in decoded:
                        await broadcast_to_clients(msg)

            except Exception as e:
                log.error("broadcast error: %s", e)
        await asyncio.sleep(interval)


async def mock_decode_loop():
    """Generate and broadcast simulated RFID decode messages."""
    while mock_decoder and mock_decoder.enabled:
        try:
            messages = mock_decoder.generate_round()
            prev_delay = 0
            for delay_ms, msg in messages:
                wait = (delay_ms - prev_delay) / 1000.0
                if wait > 0:
                    await asyncio.sleep(wait)
                prev_delay = delay_ms
                await broadcast_to_clients(msg)
            # Inter-round gap
            await asyncio.sleep(0.10 + random.random() * 0.15)
        except asyncio.CancelledError:
            return
        except Exception as e:
            log.error("mock decode error: %s", e)
            await asyncio.sleep(0.5)


async def select_device(index):
    """Select an RTL-SDR device (or simulated). Returns response dict."""
    global analyzer, pie_decoder, mock_decoder, broadcast_task, decode_task

    # Cancel running tasks
    for task in [broadcast_task, decode_task]:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    broadcast_task = None
    decode_task = None

    # Close existing analyzer
    if analyzer:
        analyzer.close()
        analyzer = None
    pie_decoder = None
    mock_decoder = None

    args = _cli_args
    fps = args.fps if args else 20

    if index == -1:
        # Simulated mode
        analyzer = SimulatedAnalyzer(
            center_freq=(args.freq if args else 915.0) * 1e6,
            sample_rate=(args.rate if args else 2.4) * 1e6,
            gain=args.gain if args else 40,
            fft_size=args.fft if args else 1024,
        )
        analyzer.open()
        mock_decoder = MockRFIDDecoder()
        broadcast_task = asyncio.create_task(spectrum_loop(fps))
        decode_task = asyncio.create_task(mock_decode_loop())
        name = "Simulated RTL-SDR"
        log.info("Selected device: %s", name)
        return {"type": "device_selected", "name": name, "success": True}
    else:
        # Real hardware
        try:
            analyzer = SpectrumAnalyzer(
                center_freq=(args.freq if args else 915.0) * 1e6,
                sample_rate=(args.rate if args else 2.4) * 1e6,
                gain=args.gain if args else 40,
                fft_size=args.fft if args else 1024,
                device_index=index,
            )
            analyzer.open()
            pie_decoder = PIEDecoder(
                sample_rate=int(analyzer.sample_rate),
                center_freq_mhz=analyzer.center_freq / 1e6,
            )
            broadcast_task = asyncio.create_task(spectrum_loop(fps))
            name = f"RTL-SDR #{index}"
            log.info("Selected device: %s", name)
            return {"type": "device_selected", "name": name, "success": True}
        except Exception as e:
            log.error("Failed to open device %d: %s", index, e)
            return {"type": "device_selected", "name": "", "success": False, "error": str(e)}


async def handler(ws):
    """Handle a single WebSocket client."""
    connected_clients.add(ws)
    log.info("Client connected (%d total)", len(connected_clients))

    # Send device list on connect
    try:
        devices = enumerate_devices()
        await ws.send(json.dumps({"type": "devices", "devices": devices}))
    except Exception as e:
        log.error("Error sending device list: %s", e)

    try:
        async for msg in ws:
            try:
                cmd = json.loads(msg)
                await process_command(cmd, ws)
            except json.JSONDecodeError:
                pass
    finally:
        connected_clients.discard(ws)
        log.info("Client disconnected (%d total)", len(connected_clients))


async def process_command(cmd, ws):
    """Process a control command from the UI."""
    action = cmd.get("action")

    if action == "list_devices":
        devices = enumerate_devices()
        await ws.send(json.dumps({"type": "devices", "devices": devices}))

    elif action == "select_device":
        result = await select_device(cmd.get("index", -1))
        await ws.send(json.dumps(result))

    elif action == "set_sequence_mode":
        if mock_decoder:
            mock_decoder.mode = cmd.get("value", "mixed")

    elif analyzer:
        if action == "set_center_freq":
            analyzer.set_center_freq(float(cmd["value"]) * 1e6)
            if pie_decoder:
                pie_decoder.set_center_freq(float(cmd["value"]))
        elif action == "set_gain":
            analyzer.set_gain(float(cmd["value"]))
        elif action == "set_sample_rate":
            analyzer.set_sample_rate(float(cmd["value"]) * 1e6)
            if pie_decoder:
                pie_decoder.reset()
        elif action == "set_fft_size":
            analyzer.set_fft_size(int(cmd["value"]))
        elif action == "set_avg_alpha":
            analyzer.avg_alpha = float(cmd["value"])
        elif action == "reset_peak":
            analyzer.reset_peak_hold()


# ===========================================================================
# HTTP Server
# ===========================================================================

def start_http_server(port, directory):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)
        def log_message(self, fmt, *args):
            pass

    httpd = HTTPServer(("0.0.0.0", port), Handler)
    log.info("HTTP server on http://0.0.0.0:%d", port)
    httpd.serve_forever()


# ===========================================================================
# Entry Point
# ===========================================================================

async def main(args):
    global _cli_args
    _cli_args = args

    # Start HTTP file server in a daemon thread
    ui_dir = str(Path(__file__).parent)
    http_thread = threading.Thread(target=start_http_server,
                                   args=(args.http_port, ui_dir),
                                   daemon=True)
    http_thread.start()

    # Start WebSocket server (no analyzer yet — client selects device)
    log.info("WebSocket server on ws://0.0.0.0:%d", args.ws_port)
    log.info("Open http://localhost:%d to start", args.http_port)
    async with websockets.serve(handler, "0.0.0.0", args.ws_port):
        await asyncio.Future()  # run forever


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

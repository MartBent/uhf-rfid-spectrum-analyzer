# UHF RFID Spectrum Analyzer

Real-time spectrum analyzer for UHF RFID bands (860–960 MHz) using an RTL-SDR dongle. Supports two connection modes:

- **WebSocket mode** — Python backend controls the RTL-SDR; data streamed to browser via WebSocket
- **WebUSB mode** — Browser talks directly to the RTL-SDR over USB (no backend needed, Chrome/Edge only)

## Features

- Real-time spectrum display with configurable FFT size (256–4096)
- Waterfall / spectrogram view
- UHF RFID band overlays for FCC, ETSI, China, Japan, Korea, Brazil, Australia
- Live, average (EMA), and peak-hold traces
- Frequency markers with peak search
- Quick-tune presets for regional RFID bands
- Adjustable center frequency, span, gain, reference level, and dynamic range
- Simulation mode for development without hardware

## Requirements

### WebSocket mode (Python backend)

```
Python 3.8+
pip install -r requirements.txt
```

Hardware: RTL-SDR dongle (RTL2832U-based)

System: `librtlsdr` must be installed:
- Debian/Ubuntu: `sudo apt install librtlsdr-dev`
- macOS: `brew install librtlsdr`
- Windows: Zadig driver + librtlsdr DLLs

### WebUSB mode (browser-only)

- Chrome, Edge, or Opera (WebUSB support required)
- HTTPS or localhost
- Linux: udev rule for RTL-SDR USB access (or run browser as root for testing)

## Usage

### Option 1: WebSocket mode (Python backend)

```bash
# Start with real hardware
python server.py

# Start in simulation mode (no RTL-SDR needed)
python server.py --simulate

# Custom settings
python server.py -f 915 -r 2.4 -g 40 -n 1024 --fps 20
```

Then open `http://localhost:8080` in your browser.

#### CLI options

| Flag | Description | Default |
|------|-------------|---------|
| `-f` | Center frequency (MHz) | 915 |
| `-r` | Sample rate / span (MHz) | 2.4 |
| `-g` | RF gain (dB) | 40 |
| `-n` | FFT size | 1024 |
| `-d` | RTL-SDR device index | 0 |
| `--ws-port` | WebSocket port | 8765 |
| `--http-port` | HTTP port | 8080 |
| `--fps` | Target frame rate | 20 |
| `--simulate` | Simulated SDR data | off |

### Option 2: WebUSB mode (no backend)

Serve the files over HTTPS or localhost:

```bash
# Simple local server
python -m http.server 8080
```

Open `http://localhost:8080` in Chrome/Edge, click **WebUSB** in the sidebar, then **Connect RTL-SDR via USB**.

The browser will prompt you to select the RTL-SDR device. All signal processing (FFT, averaging, peak hold) runs client-side in JavaScript.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser UI (index.html)                        │
│  ┌───────────┐  ┌───────────┐  ┌─────────────┐ │
│  │ Spectrum   │  │ Waterfall │  │ Controls /  │ │
│  │ Canvas     │  │ Canvas    │  │ Markers     │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬──────┘ │
│        └───────┬───────┘               │        │
│           latestData                   │        │
│        ┌───────┴───────┐               │        │
│   ┌────┴────┐    ┌─────┴──────┐        │        │
│   │WebSocket│    │  WebUSB    │        │        │
│   │ Client  │    │  RTL-SDR   │        │        │
│   └────┬────┘    │  Driver +  │        │        │
│        │         │  JS FFT    │        │        │
│        │         └─────┬──────┘        │        │
└────────┼───────────────┼───────────────┘        │
         │               │ USB                     │
    WebSocket        ┌───┴───┐                     │
         │           │RTL-SDR│                     │
  ┌──────┴──────┐    │dongle │                     │
  │ server.py   │    └───────┘                     │
  │ Python +    │                                  │
  │ pyrtlsdr +  │                                  │
  │ numpy FFT   │                                  │
  └──────┬──────┘                                  │
         │ USB                                     │
    ┌────┴────┐                                    │
    │ RTL-SDR │                                    │
    │ dongle  │                                    │
    └─────────┘                                    │
```

## File Structure

```
rfid-spectrum-analyzer/
├── index.html           # Main UI (spectrum + waterfall + controls)
├── webusb-rtlsdr.js     # WebUSB RTL-SDR driver + browser-side FFT
├── server.py            # Python WebSocket backend
├── requirements.txt     # Python dependencies
└── README.md
```

#!/usr/bin/env python3
import base64
import io
import math
import re
import urllib.request
import wave
from pathlib import Path

import numpy as np

SOURCE_URL = "https://raw.githubusercontent.com/ssabeeth/v8-engine-explorer/main/src/42_samples.js"
OUT_DIR = Path("preview")
OUT_WAV = OUT_DIR / "ferrari-v8-loop-proof.wav"

def download_text(url):
    req = urllib.request.Request(url, headers={"User-Agent":"TeslaSoundLabPreview/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")

def extract_loops(js):
    # Match each loop object by its rpm and embedded WAV data URL.
    pattern = re.compile(r"rpm:\s*(\d+).*?data:audio/wav;base64,([^'\"]+)", re.S)
    found = pattern.findall(js)
    if len(found) < 4:
        raise RuntimeError(f"Expected >=4 real loops, found {len(found)}")
    return [(int(rpm), base64.b64decode(b64)) for rpm, b64 in found[:4]]

def read_wav(raw):
    with wave.open(io.BytesIO(raw), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        n = w.getnframes()
        if sw != 2:
            raise RuntimeError(f"Expected 16-bit WAV, got sample width {sw}")
        data = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768.0
        data = data.reshape(-1, ch)
    return sr, data

def resample_channels(data, src_sr, dst_sr):
    if src_sr == dst_sr:
        return data
    duration = len(data) / src_sr
    n = int(round(duration * dst_sr))
    old_x = np.linspace(0.0, 1.0, len(data), endpoint=False)
    new_x = np.linspace(0.0, 1.0, n, endpoint=False)
    out = np.empty((n, data.shape[1]), dtype=np.float32)
    for c in range(data.shape[1]):
        out[:, c] = np.interp(new_x, old_x, data[:, c])
    return out

def rpm_curve(sr, duration=18.0):
    n = int(sr*duration)
    t = np.arange(n, dtype=np.float64)/sr
    rpm = np.empty(n, dtype=np.float64)

    # The proof deliberately includes steady holds. If a loop seam is bad,
    # it will be obvious instead of hidden by constant acceleration.
    key = [
        (0.0, 2977.0),
        (2.5, 2977.0),
        (6.0, 4438.0),
        (8.0, 4438.0),
        (11.5, 6040.0),
        (13.0, 6040.0),
        (16.0, 7252.0),
        (18.0, 7252.0),
    ]
    for i in range(len(key)-1):
        t0,r0 = key[i]
        t1,r1 = key[i+1]
        mask = (t >= t0) & (t < t1 if i < len(key)-2 else t <= t1)
        u = np.clip((t[mask]-t0)/max(1e-9,t1-t0),0,1)
        # Smoothstep removes abrupt acceleration changes.
        s = u*u*(3-2*u)
        rpm[mask] = r0 + (r1-r0)*s
    return t, rpm.astype(np.float32)

def weights_for_rpm(rpm, anchors):
    n = len(rpm)
    m = len(anchors)
    W = np.zeros((m,n), dtype=np.float32)
    W[0, rpm <= anchors[0]] = 1.0
    W[-1, rpm >= anchors[-1]] = 1.0
    for i in range(m-1):
        a,b = anchors[i],anchors[i+1]
        mask = (rpm >= a) & (rpm <= b)
        x = np.clip((rpm[mask]-a)/(b-a),0,1)
        W[i,mask] = np.cos(x*np.pi/2)
        W[i+1,mask] = np.sin(x*np.pi/2)
    return W

def render():
    js = download_text(SOURCE_URL)
    raw_loops = extract_loops(js)

    target_sr = 44100
    loops = []
    anchors = []
    channels = 2

    for rpm, raw in raw_loops:
        sr, data = read_wav(raw)
        data = resample_channels(data, sr, target_sr)
        if data.shape[1] == 1:
            data = np.repeat(data,2,axis=1)
        elif data.shape[1] > 2:
            data = data[:,:2]
        loops.append(data)
        anchors.append(float(rpm))

    order = np.argsort(anchors)
    anchors = [anchors[i] for i in order]
    loops = [loops[i] for i in order]

    t,rpm = rpm_curve(target_sr)
    W = weights_for_rpm(rpm, anchors)
    out = np.zeros((len(rpm),2), dtype=np.float32)

    for i,(anchor,buf) in enumerate(zip(anchors,loops)):
        # Keep each recording close to its natural pitch. Phase is continuous
        # across the entire preview, so loop wrap points do not restart the engine.
        rate = np.clip(rpm/anchor, 0.78, 1.22).astype(np.float64)
        phase = np.cumsum(rate)
        phase += (i*0.173*len(buf))
        pos = np.mod(phase, len(buf))
        idx0 = np.floor(pos).astype(np.int64)
        idx1 = (idx0+1) % len(buf)
        frac = (pos-idx0).astype(np.float32)[:,None]
        sig = buf[idx0]*(1-frac) + buf[idx1]*frac
        out += sig * W[i][:,None]

    # Natural-feeling loudness increase with RPM, no fake pops/crackles.
    rpm_n = np.clip((rpm-anchors[0])/(anchors[-1]-anchors[0]),0,1)
    loud = (0.70 + 0.22*rpm_n)[:,None]
    out *= loud

    # Gentle fade in/out only.
    fade_n = int(0.18*target_sr)
    fade = np.linspace(0,1,fade_n,dtype=np.float32)
    out[:fade_n] *= fade[:,None]
    out[-fade_n:] *= fade[::-1,None]

    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out *= min(1.0, 0.94/peak)

    pcm = (np.clip(out,-1,1)*32767).astype("<i2")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT_WAV),"wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(target_sr)
        w.writeframes(pcm.tobytes())

    print("anchors:", anchors)
    print("wrote:", OUT_WAV, OUT_WAV.stat().st_size)

if __name__ == "__main__":
    render()

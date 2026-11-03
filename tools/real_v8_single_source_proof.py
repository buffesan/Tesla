#!/usr/bin/env python3
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np


def read_wav(path):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        n = w.getnframes()
        if sw != 2:
            raise RuntimeError("expected PCM16 WAV")
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    data = data.reshape(-1, ch).mean(axis=1)
    return sr, data


def resample_linear(x, src_sr, dst_sr):
    if src_sr == dst_sr:
        return x.astype(np.float32, copy=False)
    n = int(round(len(x) * dst_sr / src_sr))
    old = np.linspace(0.0, 1.0, len(x), endpoint=False)
    new = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(new, old, x).astype(np.float32)


def estimate_firing_freq(frame, sr):
    x = frame.astype(np.float64)
    x -= np.mean(x)
    if np.max(np.abs(x)) < 1e-5:
        return None
    x *= np.hanning(len(x))
    nfft = 1
    while nfft < len(x) * 2:
        nfft *= 2
    spec = np.fft.rfft(x, nfft)
    ac = np.fft.irfft(spec * np.conj(spec), nfft)[:len(x)]
    ac /= max(ac[0], 1e-12)

    min_f = 45.0
    max_f = 520.0
    min_lag = max(2, int(sr / max_f))
    max_lag = min(len(ac) - 2, int(sr / min_f))
    if max_lag <= min_lag:
        return None

    search = ac[min_lag:max_lag + 1]
    lag = min_lag + int(np.argmax(search))
    corr = float(ac[lag])

    # Parabolic refinement around the autocorrelation peak.
    if 1 <= lag < len(ac) - 1:
        y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
        den = y0 - 2 * y1 + y2
        if abs(den) > 1e-12:
            lag = lag + 0.5 * (y0 - y2) / den

    freq = sr / lag
    return float(freq), corr


def analyze_candidates(sr, audio):
    ana_sr = 4000
    x = resample_linear(audio, sr, ana_sr)
    win_s = 0.72
    hop_s = 0.12
    win = int(win_s * ana_sr)
    hop = int(hop_s * ana_sr)

    candidates = []
    for pos in range(0, len(x) - win, hop):
        frame = x[pos:pos + win]
        level = float(np.sqrt(np.mean(frame * frame)))
        if level < 0.008:
            continue

        whole = estimate_firing_freq(frame, ana_sr)
        first = estimate_firing_freq(frame[:win // 2], ana_sr)
        second = estimate_firing_freq(frame[win // 2:], ana_sr)
        if whole is None or first is None or second is None:
            continue

        f, corr = whole
        f1, c1 = first
        f2, c2 = second
        rpm = 15.0 * f
        rpm1 = 15.0 * f1
        rpm2 = 15.0 * f2
        if not (650 <= rpm <= 7800):
            continue

        drift_oct = abs(math.log2(max(rpm1, 1.0) / max(rpm2, 1.0)))
        corr_min = min(corr, c1, c2)
        quality = corr_min - 1.8 * drift_oct

        if corr_min < 0.22 or drift_oct > 0.22:
            continue

        candidates.append({
            "time": pos / ana_sr + win_s / 2,
            "rpm": rpm,
            "corr": corr_min,
            "drift_oct": drift_oct,
            "quality": quality,
            "level": level,
        })

    if len(candidates) < 20:
        raise RuntimeError(f"not enough stable engine candidates: {len(candidates)}")
    return candidates


def choose_anchors(candidates, count=7):
    rpms = np.array([c["rpm"] for c in candidates], dtype=np.float64)
    good = [c for c in candidates if c["quality"] >= np.quantile([z["quality"] for z in candidates], 0.45)]
    if len(good) >= 12:
        candidates = good
        rpms = np.array([c["rpm"] for c in candidates], dtype=np.float64)

    lo = max(800.0, float(np.quantile(rpms, 0.08)))
    hi = min(7200.0, float(np.quantile(rpms, 0.92)))
    if hi < lo * 1.8:
        lo = max(800.0, float(np.min(rpms)))
        hi = min(7200.0, float(np.max(rpms)))

    targets = np.geomspace(lo, hi, count)
    chosen = []
    used_times = []

    for target in targets:
        scored = []
        for c in candidates:
            if any(abs(c["time"] - t) < 1.3 for t in used_times):
                continue
            pitch_err = abs(math.log(max(c["rpm"], 1.0) / target))
            score = c["quality"] - 0.80 * pitch_err
            scored.append((score, c))

        if not scored:
            break
        scored.sort(key=lambda z: z[0], reverse=True)
        c = dict(scored[0][1])
        c["target_rpm"] = float(target)
        chosen.append(c)
        used_times.append(c["time"])

    chosen.sort(key=lambda c: c["rpm"])
    if len(chosen) < 5:
        raise RuntimeError("could not select enough distinct stable RPM regions")
    return chosen


def seam_score(seg, start, length, fade):
    a = seg[start:start + fade]
    b = seg[start + length - fade:start + length]
    if len(a) != fade or len(b) != fade:
        return 1e9
    amp = float(np.mean((a - b) ** 2))
    da = np.diff(a)
    db = np.diff(b)
    der = float(np.mean((da - db) ** 2)) if len(da) else 0.0
    return amp + 0.25 * der


def make_seamless_loop(audio, sr, center_s, rpm):
    center = int(round(center_s * sr))
    radius = int(1.25 * sr)
    lo = max(0, center - radius)
    hi = min(len(audio), center + radius)
    region = audio[lo:hi].astype(np.float32)
    region -= float(np.mean(region))

    firing_hz = max(45.0, rpm / 15.0)
    period = sr / firing_hz
    desired = int(1.10 * sr)
    cycles = max(20, int(round(desired / period)))
    length = int(round(cycles * period))
    length = min(length, len(region) - int(0.18 * sr))

    fade = int(0.055 * sr)
    search_start = int(0.12 * sr)
    search_end = max(search_start + 1, len(region) - length - int(0.12 * sr))

    best = None
    step = max(1, int(period / 4))
    for start in range(search_start, search_end, step):
        score = seam_score(region, start, length, fade)
        if best is None or score < best[0]:
            best = (score, start)

    if best is None:
        raise RuntimeError("no loop seam candidate")

    score, start = best
    raw = region[start:start + length].copy()

    # Circular crossfade. Result begins with tail->head blend, then continues
    # through the untouched middle. Both internal transitions are continuous.
    w = np.linspace(0.0, 1.0, fade, endpoint=False, dtype=np.float32)
    cross = raw[-fade:] * (1.0 - w) + raw[:fade] * w
    loop = np.concatenate([cross, raw[fade:-fade]])

    rms = float(np.sqrt(np.mean(loop * loop)))
    if rms > 1e-6:
        loop *= min(3.0, 0.16 / rms)
    peak = float(np.max(np.abs(loop)))
    if peak > 0.92:
        loop *= 0.92 / peak

    return loop.astype(np.float32), float(score)


def axis_weights(values, anchors):
    values = np.asarray(values, dtype=np.float32)
    anchors = np.asarray(anchors, dtype=np.float32)
    W = np.zeros((len(anchors), len(values)), dtype=np.float32)
    W[0, values <= anchors[0]] = 1.0
    W[-1, values >= anchors[-1]] = 1.0

    for i in range(len(anchors) - 1):
        a, b = anchors[i], anchors[i + 1]
        mask = (values >= a) & (values <= b)
        if not np.any(mask):
            continue
        x = np.log(np.maximum(values[mask], 1.0) / a) / np.log(b / a)
        x = np.clip(x, 0.0, 1.0)
        s = x * x * (3.0 - 2.0 * x)
        W[i, mask] = np.sqrt(1.0 - s)
        W[i + 1, mask] = np.sqrt(s)
    return W


def build_curve(sr, anchors):
    duration = 20.0
    n = int(duration * sr)
    t = np.arange(n, dtype=np.float32) / sr
    lo = anchors[0]
    hi = anchors[-1]
    mid = anchors[len(anchors)//2]

    keys = [
        (0.0, lo),
        (2.0, lo),
        (5.5, mid),
        (7.0, mid),
        (10.2, hi),
        (10.45, anchors[max(1, len(anchors)//2 - 1)]),
        (14.0, hi),
        (17.4, anchors[1]),
        (20.0, lo),
    ]

    rpm = np.zeros(n, dtype=np.float32)
    for i in range(len(keys)-1):
        t0,r0 = keys[i]
        t1,r1 = keys[i+1]
        mask = (t >= t0) & (t <= t1 if i == len(keys)-2 else t < t1)
        u = (t[mask]-t0) / max(t1-t0, 1e-6)
        s = u*u*(3-2*u)
        rpm[mask] = r0 + (r1-r0)*s
    return t, rpm


def render(source_wav, out_wav, report_json):
    sr, audio = read_wav(source_wav)
    candidates = analyze_candidates(sr, audio)
    chosen = choose_anchors(candidates, 7)

    loops = []
    for c in chosen:
        loop, seam = make_seamless_loop(audio, sr, c["time"], c["rpm"])
        c["seam_score"] = seam
        c["loop_seconds"] = len(loop) / sr
        loops.append(loop)

    anchors = np.array([c["rpm"] for c in chosen], dtype=np.float32)
    t, rpm = build_curve(sr, anchors)
    W = axis_weights(rpm, anchors)

    out = np.zeros(len(t), dtype=np.float32)

    for i, (base_rpm, loop) in enumerate(zip(anchors, loops)):
        rate = np.clip(rpm / base_rpm, 0.88, 1.14).astype(np.float64)
        phase = np.cumsum(rate)
        phase += (i * 0.173) * len(loop)
        pos = np.mod(phase, len(loop))
        i0 = np.floor(pos).astype(np.int64)
        i1 = (i0 + 1) % len(loop)
        frac = (pos - i0).astype(np.float32)
        sig = loop[i0] * (1.0 - frac) + loop[i1] * frac
        out += sig * W[i]

    # Only mild real-world level shaping. No synthetic exhaust or fake pops.
    rn = np.clip((rpm - anchors[0]) / max(anchors[-1] - anchors[0], 1.0), 0.0, 1.0)
    out *= (0.74 + 0.24 * rn).astype(np.float32)
    out -= float(np.mean(out))

    fade_n = int(0.15 * sr)
    fade = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    out[:fade_n] *= fade
    out[-fade_n:] *= fade[::-1]

    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out *= min(1.0, 0.94 / peak)

    stereo = np.column_stack([out, out])
    pcm = (np.clip(stereo, -1.0, 1.0) * 32767).astype("<i2")

    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    report = {
        "source": "Ferrari California engine/exhaust recording",
        "anchors": [
            {
                "time_s": round(c["time"], 3),
                "detected_rpm": round(c["rpm"]),
                "correlation": round(c["corr"], 4),
                "drift_oct": round(c["drift_oct"], 5),
                "quality": round(c["quality"], 4),
                "loop_seconds": round(c["loop_seconds"], 4),
                "seam_score": c["seam_score"],
            }
            for c in chosen
        ],
        "candidate_count": len(candidates),
        "duration_s": 20.0,
    }
    Path(report_json).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: real_v8_single_source_proof.py source.wav out.wav report.json")
    render(sys.argv[1], sys.argv[2], sys.argv[3])

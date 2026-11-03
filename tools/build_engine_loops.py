#!/usr/bin/env python3
import json
import math
import os
import statistics
import wave
from array import array

SRC = "assets/maserati-source-mono.wav"
OUT_DIR = "assets/loops"
TARGETS = [
    ("idle", 900),
    ("low", 2200),
    ("mid", 3800),
    ("high", 6000),
]

def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1, "expected mono"
        assert w.getsampwidth() == 2, "expected 16-bit PCM"
        sr = w.getframerate()
        frames = w.readframes(w.getnframes())
    samples = array("h")
    samples.frombytes(frames)
    if os.sys.byteorder != "little":
        samples.byteswap()
    return sr, [s / 32768.0 for s in samples]

def rms(xs):
    if not xs:
        return 0.0
    return math.sqrt(sum(x*x for x in xs) / len(xs))

def nearest_zero_crossing(samples, idx, radius):
    lo = max(1, idx - radius)
    hi = min(len(samples) - 2, idx + radius)
    best = idx
    best_score = float("inf")
    for i in range(lo, hi):
        a, b = samples[i-1], samples[i]
        if (a <= 0 < b) or (a >= 0 > b):
            score = abs(a) + abs(b)
            if score < best_score:
                best = i
                best_score = score
    return best

def corr_at_lag(x, lag):
    n = len(x) - lag
    if n <= 16:
        return 0.0
    num = 0.0
    a2 = 0.0
    b2 = 0.0
    for i in range(n):
        a = x[i]
        b = x[i + lag]
        num += a * b
        a2 += a * a
        b2 += b * b
    den = math.sqrt(a2 * b2) + 1e-12
    return num / den

def target_pitch_score(frame, ds_sr, target_rpm):
    mean = sum(frame) / len(frame)
    x = [v - mean for v in frame]
    # V8 has four firing events per crank revolution: firing_hz = RPM / 15.
    f0 = target_rpm / 15.0
    min_f = max(35.0, f0 * 0.76)
    max_f = min(620.0, f0 * 1.24)
    min_lag = max(2, int(ds_sr / max_f))
    max_lag = max(min_lag + 1, int(ds_sr / min_f))
    best = (-2.0, None)
    for lag in range(min_lag, max_lag + 1):
        c = corr_at_lag(x, lag)
        if c > best[0]:
            best = (c, lag)
    c, lag = best
    rpm = 15.0 * ds_sr / lag if lag else 0.0
    closeness = abs(math.log(max(rpm, 1.0) / target_rpm))
    score = c - 0.18 * closeness
    return score, c, rpm

def choose_segments(sr, samples):
    # Downsample only for analysis.
    step = max(1, round(sr / 2205))
    ds = samples[::step]
    ds_sr = sr / step
    win_s = 0.60
    hop_s = 0.22
    win = int(ds_sr * win_s)
    hop = int(ds_sr * hop_s)
    start = int(ds_sr * 4.0)
    stop = len(ds) - win - int(ds_sr * 1.0)

    frames = []
    for pos in range(start, max(start, stop), hop):
        x = ds[pos:pos + win]
        level = rms(x)
        if level < 0.008:
            continue
        frames.append({
            "pos": pos,
            "time": pos / ds_sr,
            "level": level,
            "frame": x,
        })

    if not frames:
        raise RuntimeError("no usable audio frames found")

    levels = [f["level"] for f in frames]
    median_level = statistics.median(levels)

    chosen = []
    used_times = []
    for name, target in TARGETS:
        candidates = []
        for f in frames:
            if any(abs(f["time"] - t) < 1.6 for t in used_times):
                continue
            score, corr, rpm = target_pitch_score(f["frame"], ds_sr, target)

            # Prefer useful engine content over near-silence and avoid isolated transients.
            level_ratio = max(0.2, min(3.0, f["level"] / (median_level + 1e-9)))
            level_bonus = 0.04 * math.log(level_ratio)
            transient_penalty = 0.0
            if f["time"] < 7.0:
                transient_penalty = 0.05

            candidates.append((score + level_bonus - transient_penalty, corr, rpm, f))

        if not candidates:
            raise RuntimeError("not enough separated candidates")

        candidates.sort(key=lambda x: x[0], reverse=True)
        score, corr, rpm, f = candidates[0]
        used_times.append(f["time"])
        chosen.append({
            "name": name,
            "target_rpm": target,
            "detected_rpm": round(rpm),
            "correlation": round(corr, 4),
            "time": round(f["time"], 3),
            "level": round(f["level"], 6),
        })
    return chosen

def write_loop(sr, samples, info):
    detected_rpm = max(600, info["detected_rpm"])
    firing_hz = detected_rpm / 15.0
    period = sr / firing_hz

    desired_len = sr * 1.10
    cycles = max(8, round(desired_len / period))
    loop_len = int(round(cycles * period))

    center = int(info["time"] * sr + 0.30 * sr)
    start_guess = center - loop_len // 2
    start_guess = max(int(0.5 * sr), min(len(samples) - loop_len - int(0.5 * sr), start_guess))
    start = nearest_zero_crossing(samples, start_guess, int(sr * 0.025))
    end = start + loop_len
    if end >= len(samples):
        end = len(samples) - 1
        start = end - loop_len

    segment = samples[start:end]
    seg_rms = rms(segment)
    gain = min(3.0, 0.19 / max(seg_rms, 1e-6))
    peak = max(abs(v * gain) for v in segment) if segment else 1.0
    if peak > 0.94:
        gain *= 0.94 / peak

    pcm = array("h")
    for v in segment:
        y = max(-1.0, min(1.0, v * gain))
        pcm.append(int(round(y * 32767)))

    path = os.path.join(OUT_DIR, info["name"] + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    info["loop_start_s"] = round(start / sr, 4)
    info["loop_end_s"] = round(end / sr, 4)
    info["loop_duration_s"] = round((end - start) / sr, 4)
    info["file"] = "assets/loops/" + info["name"] + ".wav"

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    sr, samples = read_wav(SRC)
    chosen = choose_segments(sr, samples)
    for info in chosen:
        write_loop(sr, samples, info)

    manifest = {
        "source": "Maserati GranTurismo S Exhaust.ogg",
        "author": "lmartins",
        "license": "CC BY 4.0",
        "source_url": "https://commons.wikimedia.org/wiki/File:Maserati_GranTurismo_S_Exhaust.ogg",
        "sample_rate": sr,
        "loops": chosen,
    }
    with open(os.path.join(OUT_DIR, "loops.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    for item in chosen:
        print(item)

if __name__ == "__main__":
    main()

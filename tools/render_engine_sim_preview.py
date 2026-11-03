#!/usr/bin/env python3
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def read_mono_wav(path, target_sr):
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        frames = w.getnframes()
        if width != 2:
            raise RuntimeError(f"{path}: expected PCM16, got sample width {width}")
        raw = w.readframes(frames)

    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    data = data.reshape(-1, channels).mean(axis=1)

    if sr != target_sr:
        old_x = np.linspace(0.0, 1.0, len(data), endpoint=False)
        n = int(round(len(data) * target_sr / sr))
        new_x = np.linspace(0.0, 1.0, n, endpoint=False)
        data = np.interp(new_x, old_x, data).astype(np.float32)

    return data


def axis_weights(values, anchors):
    anchors = np.asarray(anchors, dtype=np.float32)
    values = np.asarray(values, dtype=np.float32)
    W = np.zeros((len(anchors), len(values)), dtype=np.float32)

    W[0, values <= anchors[0]] = 1.0
    W[-1, values >= anchors[-1]] = 1.0

    for i in range(len(anchors) - 1):
        a = anchors[i]
        b = anchors[i + 1]
        mask = (values >= a) & (values <= b)
        if not np.any(mask):
            continue
        u = (values[mask] - a) / (b - a)
        W[i, mask] = np.cos(u * math.pi / 2.0)
        W[i + 1, mask] = np.sin(u * math.pi / 2.0)

    return W


def make_control_curve(sr, duration):
    n = int(round(sr * duration))
    t = np.arange(n, dtype=np.float32) / sr
    rpm = np.zeros(n, dtype=np.float32)
    load = np.zeros(n, dtype=np.float32)

    keys = [
        (0.0, 900, 0.08),
        (2.0, 900, 0.08),
        (5.2, 3600, 0.72),
        (6.4, 3600, 0.72),
        (9.2, 6200, 1.00),
        (9.45, 3900, 0.12),
        (12.5, 6200, 1.00),
        (16.0, 2200, 0.00),
        (18.0, 900, 0.06),
        (20.0, 900, 0.06),
    ]

    for i in range(len(keys) - 1):
        t0, r0, l0 = keys[i]
        t1, r1, l1 = keys[i + 1]
        last = i == len(keys) - 2
        mask = (t >= t0) & (t <= t1 if last else t < t1)
        u = (t[mask] - t0) / max(t1 - t0, 1e-6)
        s = smoothstep(u)
        rpm[mask] = r0 + (r1 - r0) * s
        load[mask] = l0 + (l1 - l0) * s

    return t, rpm, load


def render(bank_dir, out_wav, out_report):
    bank_dir = Path(bank_dir)
    out_wav = Path(out_wav)
    out_report = Path(out_report)

    meta = json.loads((bank_dir / "EngineAudioBank.json").read_text(encoding="utf-8-sig"))
    sr = int(meta["sampleRate"])

    states = []
    for index, state in enumerate(meta["states"]):
        path = bank_dir / Path(state["clip"])
        samples = read_mono_wav(path, sr)
        states.append({
            "rpm": float(state["rpm"]),
            "measured_rpm": float(state.get("measuredRpm") or state["rpm"]),
            "load": float(state["load"]),
            "samples": samples,
            "loop_score": float(state.get("loopScore", 0.0)),
            "seam_error": float(state.get("seamError", 0.0)),
            "phase_offset": (index * 0.173) % 1.0,
            "clip": state["clip"],
        })

    rpm_grid = sorted({s["rpm"] for s in states})
    load_grid = sorted({s["load"] for s in states})

    duration = 20.0
    t, target_rpm, target_load = make_control_curve(sr, duration)
    rpm_w = axis_weights(target_rpm, rpm_grid)
    load_w = axis_weights(target_load, load_grid)

    rpm_index = {v: i for i, v in enumerate(rpm_grid)}
    load_index = {v: i for i, v in enumerate(load_grid)}

    out = np.zeros(len(t), dtype=np.float32)

    for state in states:
        wi = rpm_w[rpm_index[state["rpm"]]] * load_w[load_index[state["load"]]]
        if float(np.max(wi)) < 1e-5:
            continue

        natural = max(state["measured_rpm"], 1.0)
        rate = np.clip(target_rpm / natural, 0.88, 1.14).astype(np.float64)

        phase = np.cumsum(rate, dtype=np.float64)
        phase += state["phase_offset"] * len(state["samples"])
        pos = np.mod(phase, len(state["samples"]))

        i0 = np.floor(pos).astype(np.int64)
        i1 = (i0 + 1) % len(state["samples"])
        frac = (pos - i0).astype(np.float32)
        sig = state["samples"][i0] * (1.0 - frac) + state["samples"][i1] * frac

        out += sig * wi

    rpm_n = np.clip((target_rpm - min(rpm_grid)) / (max(rpm_grid) - min(rpm_grid)), 0.0, 1.0)
    drive = 0.78 + 0.18 * rpm_n + 0.12 * target_load
    out *= drive.astype(np.float32)
    out -= float(np.mean(out))

    fade_n = int(sr * 0.12)
    fade = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
    out[:fade_n] *= fade
    out[-fade_n:] *= fade[::-1]

    peak = float(np.max(np.abs(out)))
    if peak > 0:
        out *= min(1.0, 0.93 / peak)

    stereo = np.column_stack((out, out))
    pcm = (np.clip(stereo, -1.0, 1.0) * 32767).astype("<i2")

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())

    report = {
        "engineName": meta.get("engineName"),
        "sourceEngineName": meta.get("sourceEngineName"),
        "sampleRate": sr,
        "idleRpm": meta.get("idleRpm"),
        "rpmGrid": rpm_grid,
        "loadGrid": load_grid,
        "durationSeconds": duration,
        "states": [
            {
                "rpm": s["rpm"],
                "measuredRpm": s["measured_rpm"],
                "load": s["load"],
                "loopScore": s["loop_score"],
                "seamError": s["seam_error"],
                "clip": s["clip"],
            }
            for s in states
        ],
    }
    out_report.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"Rendered {out_wav}")
    print(f"Engine: {report['engineName']}")
    print(f"RPM grid: {rpm_grid}")
    print(f"Load grid: {load_grid}")
    print(f"Peak before normalization: {peak:.5f}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: render_engine_sim_preview.py <bank_dir> <out.wav> <report.json>")
    render(sys.argv[1], sys.argv[2], sys.argv[3])

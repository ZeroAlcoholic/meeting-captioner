"""ASR Model Comparison Script.

Evaluates faster-whisper models side-by-side on a small set of zh-TW
and Mandarin-English code-switching audio clips.

Metrics reported per model:
  WER  — word error rate (requires `jiwer`; install: pip install jiwer)
  RTF  — real-time factor (transcription_time / audio_duration)
  VRAM — peak GPU memory used (MiB, CUDA only; 0 on CPU)

Usage:
  python scripts/compare_models.py [--models MODEL1 MODEL2 ...]
                                   [--audio-dir PATH]
                                   [--output JSON_PATH]
                                   [--device cuda|cpu]
                                   [--compute-type float16|int8]

Defaults:
  models:      distil-large-v3  breeze-asr-25
  audio-dir:   eval_audio/
  output:      eval_results.json
  device:      cuda (falls back to cpu if unavailable)
  compute-type float16

The audio directory must contain a `transcripts.json` mapping filename
to the expected reference transcription (used for WER).

Example transcripts.json:
  {
    "zh_tw_01.wav": "要保人必須簽署所有保單文件。",
    "code_switch_01.wav": "我們的ROI要exceed預期的目標。"
  }
"""
import argparse
import json
import os
import time
from pathlib import Path

import torch

try:
    from faster_whisper import WhisperModel
except ImportError:
    raise SystemExit(
        "faster-whisper not installed. Run: pip install faster-whisper"
    ) from None

try:
    import jiwer
    _JIWER_AVAILABLE = True
except ImportError:
    _JIWER_AVAILABLE = False
    print("[warn] jiwer not installed — WER will be skipped. Run: pip install jiwer")

_REPO_MAP = {
    "distil-large-v3":   "Systran/faster-distil-whisper-large-v3",
    "large-v3":          "Systran/faster-whisper-large-v3",
    "breeze-asr-25":     "SoybeanMilk/faster-whisper-Breeze-ASR-25",
    "breeze-asr-25-ct2": "phate334/Breeze-ASR-25-ct2",
}


def audio_duration_seconds(path: str) -> float:
    try:
        import wave
        with wave.open(path) as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return 0.0


def evaluate_model(
    model_name: str,
    audio_files: list[str],
    references: dict[str, str],
    device: str,
    compute_type: str,
) -> dict:
    repo_id = _REPO_MAP.get(model_name, model_name)
    print(f"\n{'='*60}")
    print(f"Model: {model_name}  ({repo_id})")
    print(f"{'='*60}")

    if device == "cuda" and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    load_start = time.perf_counter()
    model = WhisperModel(repo_id, device=device, compute_type=compute_type)
    load_elapsed = time.perf_counter() - load_start
    print(f"  load time: {load_elapsed:.1f}s")

    results = []
    for audio_path in audio_files:
        fname = os.path.basename(audio_path)
        duration = audio_duration_seconds(audio_path)

        t0 = time.perf_counter()
        segments, info = model.transcribe(
            audio_path,
            language="zh",
            task="transcribe",
            vad_filter=True,
        )
        hypothesis = " ".join(s.text.strip() for s in segments)
        elapsed = time.perf_counter() - t0

        rtf = elapsed / duration if duration > 0 else 0.0
        reference = references.get(fname, "")
        wer = None
        if _JIWER_AVAILABLE and reference:
            try:
                wer = round(jiwer.wer(reference, hypothesis), 4)
            except Exception:
                pass

        print(f"  [{fname}]")
        print(f"    hypothesis : {hypothesis[:80]}{'...' if len(hypothesis) > 80 else ''}")
        print(f"    reference  : {reference[:80]}{'...' if len(reference) > 80 else ''}")
        print(f"    RTF={rtf:.3f}  WER={wer if wer is not None else 'n/a'}")

        results.append({
            "file": fname,
            "hypothesis": hypothesis,
            "reference": reference,
            "duration_s": round(duration, 2),
            "transcription_s": round(elapsed, 3),
            "rtf": round(rtf, 4),
            "wer": wer,
            "detected_language": info.language,
        })

    vram_mib = 0
    if device == "cuda" and torch.cuda.is_available():
        vram_mib = round(torch.cuda.max_memory_allocated() / 1024**2, 1)

    # Aggregate WER across files that have references
    wers = [r["wer"] for r in results if r["wer"] is not None]
    avg_wer = round(sum(wers) / len(wers), 4) if wers else None
    rtfs = [r["rtf"] for r in results if r["rtf"] > 0]
    avg_rtf = round(sum(rtfs) / len(rtfs), 4) if rtfs else None

    print(f"\n  Summary: avg_wer={avg_wer}  avg_rtf={avg_rtf}  vram={vram_mib} MiB")

    return {
        "model": model_name,
        "repo_id": repo_id,
        "device": device,
        "compute_type": compute_type,
        "load_s": round(load_elapsed, 2),
        "vram_mib": vram_mib,
        "avg_wer": avg_wer,
        "avg_rtf": avg_rtf,
        "files": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Compare ASR models on zh-TW audio")
    parser.add_argument(
        "--models", nargs="+",
        default=["distil-large-v3", "breeze-asr-25"],
        help="Model names to evaluate (space-separated)",
    )
    parser.add_argument(
        "--audio-dir", default="eval_audio",
        help="Directory containing .wav files and transcripts.json",
    )
    parser.add_argument(
        "--output", default="eval_results.json",
        help="Path to write JSON results",
    )
    parser.add_argument(
        "--device", default="cuda" if torch.cuda.is_available() else "cpu",
        choices=["cuda", "cpu"],
    )
    parser.add_argument(
        "--compute-type", default="float16",
        choices=["float16", "int8", "int8_float16"],
    )
    args = parser.parse_args()

    audio_dir = Path(args.audio_dir)
    if not audio_dir.exists():
        raise SystemExit(f"Audio directory not found: {audio_dir}\n"
                         "Create it and add .wav files + transcripts.json")

    transcripts_file = audio_dir / "transcripts.json"
    if transcripts_file.exists():
        references = json.loads(transcripts_file.read_text(encoding="utf-8"))
    else:
        references = {}
        print("[warn] transcripts.json not found — WER will be skipped")

    audio_files = sorted(audio_dir.glob("*.wav"))
    if not audio_files:
        raise SystemExit(f"No .wav files found in {audio_dir}")

    print(f"Evaluating {len(audio_files)} file(s) with {len(args.models)} model(s)")
    print(f"Device: {args.device}  Compute: {args.compute_type}")

    all_results = []
    for model_name in args.models:
        result = evaluate_model(
            model_name,
            [str(f) for f in audio_files],
            references,
            device=args.device,
            compute_type=args.compute_type,
        )
        all_results.append(result)

    output_path = Path(args.output)
    output_path.write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nResults written to {output_path}")

    # Print side-by-side summary
    print("\n" + "="*60)
    print("COMPARISON SUMMARY")
    print("="*60)
    print(f"{'Model':<22} {'avg_WER':>8} {'avg_RTF':>8} {'VRAM(MiB)':>10} {'load(s)':>8}")
    print("-"*60)
    for r in all_results:
        print(
            f"{r['model']:<22} "
            f"{str(r['avg_wer'] or 'n/a'):>8} "
            f"{str(r['avg_rtf'] or 'n/a'):>8} "
            f"{r['vram_mib']:>10} "
            f"{r['load_s']:>8}"
        )


if __name__ == "__main__":
    main()

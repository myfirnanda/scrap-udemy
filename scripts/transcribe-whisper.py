import argparse
import json
import os
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-cache", required=True)
    parser.add_argument("--duration", type=float, default=0)
    args = parser.parse_args()

    threads = max(1, min(os.cpu_count() or 1, 8))
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
        download_root=args.model_cache,
    )
    segments, info = model.transcribe(
        args.audio,
        task="translate",
        beam_size=3,
        vad_filter=True,
        condition_on_previous_text=True,
    )

    result_segments = []
    last_percent = -1
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        result_segments.append({"start": segment.start, "end": segment.end, "text": text})
        if args.duration > 0:
            percent = min(99, max(0, round(segment.end / args.duration * 100)))
            if percent >= last_percent + 2:
                print(f"PROGRESS\t{percent}\t{segment.end:.1f}", flush=True)
                last_percent = percent

    payload = {
        "language": info.language,
        "languageProbability": info.language_probability,
        "segments": result_segments,
    }
    target = Path(args.output)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(target)
    print("PROGRESS\t100\t{:.1f}".format(args.duration), flush=True)


if __name__ == "__main__":
    main()

"""CLI: python -m services.noise_generator_service ..."""

from __future__ import annotations

import argparse
import sys

from services.noise_generator_service.generate import save_noise_png


def main() -> None:
    p = argparse.ArgumentParser(
        description="Write a PNG of Gaussian noise (local only, no Comfy/S3)."
    )
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.add_argument("--out", type=str, required=True, help="Output PNG path")
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--channels", type=int, default=3, choices=(1, 3))
    p.add_argument(
        "--mean",
        type=float,
        default=127.5,
        help="Gaussian mean (pixel scale 0–255)",
    )
    p.add_argument(
        "--std",
        type=float,
        default=25.0,
        help="Gaussian standard deviation",
    )
    p.add_argument(
        "--grayscale",
        action="store_true",
        help="One noise plane, broadcast to RGB",
    )
    args = p.parse_args()
    try:
        save_noise_png(
            args.out,
            args.width,
            args.height,
            seed=args.seed,
            channels=args.channels,
            mean=args.mean,
            std=args.std,
            grayscale=args.grayscale,
        )
    except (TypeError, ValueError) as e:
        print("ERROR:", e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

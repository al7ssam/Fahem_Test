#!/usr/bin/env python3
"""Strip UTF-8 BOM from db/migrations/* and ensure a trailing -- fix comment."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent
MIGRATIONS_DIR = ROOT / "db" / "migrations"


def strip_bom_bytes(data: bytes) -> bytes:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:]
    return data


def clean_file(path: Path) -> None:
    raw = strip_bom_bytes(path.read_bytes())
    text = raw.decode("utf-8")
    lines = text.splitlines()
    while lines and lines[-1].strip() in ("", "-- fix"):
        lines.pop()
    lines.append("-- fix")
    out = "\n".join(lines) + "\n"
    path.write_bytes(out.encode("utf-8"))


def main() -> int:
    if not MIGRATIONS_DIR.is_dir():
        print("Directory not found:", MIGRATIONS_DIR)
        return 1
    for path in sorted(MIGRATIONS_DIR.iterdir()):
        if path.is_file():
            clean_file(path)
            print("cleaned:", path.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

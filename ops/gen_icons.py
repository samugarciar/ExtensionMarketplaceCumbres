#!/usr/bin/env python3
"""Genera los iconos PNG de la extensión sin dependencias externas.

Uso:  python3 ops/gen_icons.py

El icono es una flecha blanca (el enrutado del lead) sobre un degradado que va
del azul de Facebook al verde de WhatsApp: de dónde viene el lead y a dónde va.
Se dibuja con supermuestreo 3x3 para que los bordes no queden dentados.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIZES = (16, 48, 128)
OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"

FB_BLUE = (24, 119, 242)
WA_GREEN = (37, 211, 102)
SUPERSAMPLE = 3


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def dist_to_segment(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    """Distancia de un punto al segmento (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length_sq))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def inside_rounded_square(x: float, y: float, radius: float = 0.22) -> bool:
    """x, y en [0,1]. Cuadrado con esquinas redondeadas."""
    cx = min(max(x, radius), 1 - radius)
    cy = min(max(y, radius), 1 - radius)
    if x == cx or y == cy:
        return True
    return math.hypot(x - cx, y - cy) <= radius


def inside_arrow(x: float, y: float, thickness: float) -> bool:
    """Flecha '→' centrada, en coordenadas normalizadas."""
    segments = (
        (0.28, 0.50, 0.66, 0.50),  # cuerpo
        (0.52, 0.34, 0.68, 0.50),  # punta superior
        (0.52, 0.66, 0.68, 0.50),  # punta inferior
    )
    return any(dist_to_segment(x, y, *segment) <= thickness for segment in segments)


def render(size: int) -> bytes:
    # Los iconos pequeños necesitan trazo proporcionalmente más grueso para leerse.
    thickness = 0.085 if size >= 48 else 0.105
    rows = bytearray()

    for py in range(size):
        rows.append(0)  # byte de filtro PNG (0 = None) al inicio de cada fila
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0

            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px + (sx + 0.5) / SUPERSAMPLE) / size
                    y = (py + (sy + 0.5) / SUPERSAMPLE) / size

                    if not inside_rounded_square(x, y):
                        continue

                    if inside_arrow(x, y, thickness):
                        r, g, b = 255, 255, 255
                    else:
                        t = (x + y) / 2  # degradado diagonal
                        r = lerp(FB_BLUE[0], WA_GREEN[0], t)
                        g = lerp(FB_BLUE[1], WA_GREEN[1], t)
                        b = lerp(FB_BLUE[2], WA_GREEN[2], t)

                    acc_r += r
                    acc_g += g
                    acc_b += b
                    acc_a += 255

            samples = SUPERSAMPLE * SUPERSAMPLE
            alpha = acc_a / samples
            if alpha <= 0:
                rows.extend((0, 0, 0, 0))
                continue

            # Color medio ponderado sólo por las muestras que cayeron dentro.
            covered = acc_a / 255
            rows.extend(
                (
                    round(acc_r / covered),
                    round(acc_g / covered),
                    round(acc_b / covered),
                    round(alpha),
                )
            )

    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, raw: bytes) -> None:
    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)  # RGBA, 8 bits
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"  {path.relative_to(OUT_DIR.parent.parent)}  ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    print("Generando iconos:")
    main()

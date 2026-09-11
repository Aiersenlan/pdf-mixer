#!/usr/bin/env python3
"""產生測試用的範例 PDF（純標準函式庫，不需要安裝任何套件）。

用法：
    python tools/make_samples.py

會在 samples/ 底下寫出 sample_A.pdf (3 頁)、sample_B.pdf (4 頁)、
sample_C.pdf (2 頁)、sample_D.pdf (2 頁)，每頁都有明顯的識別碼，
方便驗證合併、排序、旋轉、刪除的結果是否正確。
"""

from __future__ import annotations

import math
import pathlib

PAGE_W, PAGE_H = 595.28, 841.89

# (資料夾代號, 顯示名稱, RGB, 頁數)
DOCS = [
    ("A", "Document A", (0.145, 0.388, 0.922), 3),   # 藍
    ("B", "Document B", (0.918, 0.345, 0.047), 4),   # 橘
    ("C", "Document C", (0.020, 0.588, 0.412), 2),   # 綠
    ("D", "Document D", (0.486, 0.227, 0.929), 2),   # 紫
]

# Helvetica 的平均字寬比例，用來粗略置中，範例檔夠用了
AVG_W = {"F1": 0.52, "F2": 0.58}


def esc(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def text_width(text: str, size: float, font: str) -> float:
    return len(text) * size * AVG_W[font]


def centered(text: str, size: float, font: str, y: float, color=(0, 0, 0)) -> str:
    x = (PAGE_W - text_width(text, size, font)) / 2
    r, g, b = color
    return (
        f"BT {r:.3f} {g:.3f} {b:.3f} rg /{font} {size} Tf "
        f"1 0 0 1 {x:.2f} {y:.2f} Tm ({esc(text)}) Tj ET\n"
    )


def circle(cx: float, cy: float, r: float, color) -> str:
    """用四段貝茲曲線畫圓。"""
    k = r * 0.5523
    cr, cg, cb = color
    return (
        f"{cr:.3f} {cg:.3f} {cb:.3f} rg\n"
        f"{cx + r:.2f} {cy:.2f} m\n"
        f"{cx + r:.2f} {cy + k:.2f} {cx + k:.2f} {cy + r:.2f} {cx:.2f} {cy + r:.2f} c\n"
        f"{cx - k:.2f} {cy + r:.2f} {cx - r:.2f} {cy + k:.2f} {cx - r:.2f} {cy:.2f} c\n"
        f"{cx - r:.2f} {cy - k:.2f} {cx - k:.2f} {cy - r:.2f} {cx:.2f} {cy - r:.2f} c\n"
        f"{cx + k:.2f} {cy - r:.2f} {cx + r:.2f} {cy - k:.2f} {cx + r:.2f} {cy:.2f} c\n"
        "f\n"
    )


def page_stream(doc_name: str, tag: str, color, index: int, total: int) -> str:
    r, g, b = color
    parts = []

    # 頁面外框
    parts.append(f"{r:.3f} {g:.3f} {b:.3f} RG 2 w "
                 f"24 24 {PAGE_W - 48:.2f} {PAGE_H - 48:.2f} re S\n")

    # 頂部色帶 + 標題
    band_h = 46
    parts.append(f"{r:.3f} {g:.3f} {b:.3f} rg "
                 f"24 {PAGE_H - 24 - band_h:.2f} {PAGE_W - 48:.2f} {band_h} re f\n")
    parts.append(centered(f"{doc_name} - Page {index} of {total}  ({tag})",
                          15, "F2", PAGE_H - 24 - band_h + 16, (1, 1, 1)))

    # 中央圓形識別碼
    parts.append(circle(PAGE_W / 2, PAGE_H / 2 + 90, 78, color))
    parts.append(centered(tag, 52, "F2", PAGE_H / 2 + 90 - 18, (1, 1, 1)))

    # 說明文字
    lines = [
        f"Document: {doc_name}",
        f"Page Index: {index} of {total}",
        f"Identifier: {tag}",
    ]
    y = PAGE_H / 2 - 40
    for line in lines:
        parts.append(centered(line, 13, "F1", y, (0.25, 0.27, 0.30)))
        y -= 24

    # 頁尾
    parts.append(f"BT 0.55 0.57 0.60 rg /F1 9 Tf 1 0 0 1 40 44 Tm "
                 f"({esc('pdf_mix_claude sample - ' + doc_name)}) Tj ET\n")
    footer = f"Page {index}"
    parts.append(f"BT 0.55 0.57 0.60 rg /F1 9 Tf "
                 f"1 0 0 1 {PAGE_W - 40 - text_width(footer, 9, 'F1'):.2f} 44 Tm "
                 f"({esc(footer)}) Tj ET\n")

    return "".join(parts)


def build_pdf(streams: list[str]) -> bytes:
    """把一串內容流組成最小可用的 PDF。"""
    n = len(streams)
    objects: list[bytes] = []

    # 1: Catalog, 2: Pages, 3: Helvetica, 4: Helvetica-Bold
    kids = " ".join(f"{5 + 2 * i} 0 R" for i in range(n))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Count {n} /Kids [{kids}] >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")

    for i, content in enumerate(streams):
        content_obj = 6 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R "
            f"/MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
            f"/Contents {content_obj} 0 R >>".encode()
        )
        data = content.encode("latin-1")
        objects.append(f"<< /Length {len(data)} >>\nstream\n".encode()
                       + data + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF\n").encode()
    return bytes(out)


def main() -> None:
    out_dir = pathlib.Path(__file__).resolve().parent.parent / "samples"
    out_dir.mkdir(exist_ok=True)

    for letter, name, color, pages in DOCS:
        streams = [
            page_stream(name, f"{letter}{i}", color, i, pages)
            for i in range(1, pages + 1)
        ]
        path = out_dir / f"sample_{letter}.pdf"
        path.write_bytes(build_pdf(streams))
        print(f"  {path.name}  {pages} 頁  {path.stat().st_size:,} bytes")

    print(f"\n完成，共 {len(DOCS)} 個範例檔 -> {out_dir}")


if __name__ == "__main__":
    main()

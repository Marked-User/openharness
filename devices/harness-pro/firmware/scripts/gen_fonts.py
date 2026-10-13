#!/usr/bin/env python3
"""Bake regular-weight outlines into the bounded 4-bit Pro text atlases.

    python3 scripts/gen_fonts.py [--font PATH] --out FILE

Emits ht_pro_24, ht_pro_32, ht_pro_42 and ht_pro_56 (ht_pro_font_t, see main/display/pro_font_type.h).
The default font is the system sans on macOS when present, else the bundled Liberation Sans.
Also emits the Console faces (cs_sb_*, cs_md_*, cs_rg_*, cs_mono_*) from the committed Inter / JetBrains Mono TTFs in
fonts/, whatever --font says: full coverage, plus the CONSOLE_EXTRA marks appended after the Vietnamese entries.
And the Classic faces (ci_rg_*, ci_bd_*) from Liberation Sans Regular / Bold in fonts/, with the ellipsis appended.
The output is a build artifact; it is generated at build time and never committed.
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SYSTEM_FONT = Path('/System/Library/Fonts/Helvetica.ttc')
BUNDLED_FONT = ROOT / 'fonts' / 'LiberationSans-Regular.ttf'
SIZES = (24, 32, 42, 56)
# Pod draws only these characters at the two big sizes (test_only_sparse_chars_drawn guards it), so only they
# get masks. Every other glyph keeps its metrics and points at a shared run of zeros (draws nothing).
SPARSE = {42: "#>_?", 56: "#>_?"}
# The 90 Vietnamese precomposed letters, then the 12 letters outside that block.
# Keep in sync with ht_pro_vietnamese_index().
VIETNAMESE = list(range(0x1ea0, 0x1efa)) + [0x102, 0x103, 0x110, 0x111, 0x128, 0x129,
                                            0x168, 0x169, 0x1a0, 0x1a1, 0x1af, 0x1b0]
# Console faces: (symbol, font file, size). Extras follow the Vietnamese entries; each face lists its own extras in its extras table (ht_pro_font_t.extras), which pro_canvas.c searches.
# Console glyphs are cropped to their inked rows (ht_pro_glyph_t top/rows). A mark the face lacks gets a copy of '?', so it never draws as an empty box.
FONTS = ROOT / 'fonts'
CONSOLE = [('cs_sb_48', 'Inter-SemiBold.ttf', 48), ('cs_sb_34', 'Inter-SemiBold.ttf', 34),
           ('cs_sb_26', 'Inter-SemiBold.ttf', 26), ('cs_sb_22', 'Inter-SemiBold.ttf', 22),
           ('cs_rg_24', 'Inter-Regular.ttf', 24), ('cs_rg_20', 'Inter-Regular.ttf', 20),
           ('cs_rg_17', 'Inter-Regular.ttf', 17), ('cs_mono_26', 'JetBrainsMono-Medium.ttf', 26),
           ('cs_mono_18', 'JetBrainsMono-Medium.ttf', 18), ('cs_mono_15', 'JetBrainsMono-Medium.ttf', 15),
           # v2
           ('cs_md_28', 'Inter-Medium.ttf', 28), ('cs_sb_32', 'Inter-SemiBold.ttf', 32),
           ('cs_rg_36', 'Inter-Regular.ttf', 36), ('cs_rg_27', 'Inter-Regular.ttf', 27),
           ('cs_rg_22', 'Inter-Regular.ttf', 22),
           ('cs_mono_24', 'JetBrainsMono-Medium.ttf', 24), ('cs_mono_22', 'JetBrainsMono-Medium.ttf', 22)]
# Faces that draw a known set of characters keep only those (the font total cap is 900 KB). cs_sb_48 draws the Update screen's version ("0.1.3", "0.1.0-RC1", "0.0.99-pod", a cut one ending in "\u2026"). cs_mono_24 draws a row's time
# ("2:38", "ask", "4m", "now"): printable ASCII.
CONSOLE_CUT = {'cs_sb_48': '0123456789.-+_ abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\u2026',
               'cs_mono_24': ''.join(chr(c) for c in range(32, 127))}
CONSOLE_EXTRA = [0x2026, 0x2192, 0x2191, 0x2193, 0x2190, 0x21e2, 0x25b2, 0x25c6, 0x2713]
# Classic faces: Liberation Sans Regular / Bold, always from fonts/ whatever --font says. Latin-1 and Vietnamese, plus
# CLASSIC_EXTRA after them (the ellipsis; U+00B7 is Latin-1). Each face carries its own table of these code points
# (emitted by emit()); pro_canvas.c draws a mark only if the face's table lists it.
LS_REG, LS_BOLD = 'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf'
CLASSIC = ([('ci_rg_%d' % n, LS_REG, n) for n in (20, 22, 23, 24, 25, 26, 28, 30, 32, 33, 41, 43, 48)]
           + [('ci_bd_%d' % n, LS_BOLD, n) for n in (20, 23, 24, 26, 30, 45)])
CLASSIC_EXTRA = [0x2026, 0x2014]   # ellipsis, em dash (unknown time)
# Faces that draw a few known strings keep only those characters (the Classic total cap is 800 KB, see test_fonts.py).
_DIGITS = '0123456789'
_ASCII = ''.join(chr(c) for c in range(0x20, 0x7f)) + '\u2026\u00b7\u2014'   # fixed English copy, digits or the brand: no Latin-1 high half or Vietnamese
CLASSIC_CUT = {'ci_rg_20': _ASCII,   # labels, "Updated\u2026", footer caps
               'ci_rg_25': _ASCII,   # band state word, "Connection lost" copy
               'ci_rg_28': _ASCII,   # Talk button
               'ci_bd_20': _ASCII,   # eyebrows, list state words
               'ci_bd_24': _ASCII,   # count pill
               'ci_bd_26': _ASCII,   # brand "Harness"
               'ci_rg_43': 'No panes yet.' + 'Connection lost.',
               'ci_rg_48': 'Listening.' + 'unread.' + _DIGITS,
               'ci_bd_45': 'Sending your words\u2026' + 'Updating to' + 'Restarting\u2026' + _DIGITS + '.'
               + ''.join(chr(c) for c in range(0x20, 0x7f))}   # "Updating to %s" draws any version string


def has_glyph(f, cp):
    """True when the face draws cp itself (not its .notdef box)."""
    return bytes(f.getmask(chr(cp))) != bytes(f.getmask(chr(0x10fffe)))


def bake(font_path, size, sparse_chars=None, extras=(), crop=False):
    height = math.ceil(size * 1.375)
    f = ImageFont.truetype(str(font_path), size * 2, index=0)  # 2x supersampling
    data = bytearray()
    glyphs = []
    masks = {}
    sparse = SPARSE.get(size) if sparse_chars is None else (sparse_chars or None)
    blank = 0  # length of the zero run at offset 0
    for cp in list(range(32, 256)) + VIETNAMESE + list(extras):
        ch = chr(cp) if cp < 127 or (160 <= cp and (cp not in extras or has_glyph(f, cp))) else '?'
        advance = max(1, math.ceil(f.getlength(ch) / 2))
        width = advance + 2
        im = Image.new('L', (width * 2, height * 2))
        baseline = size * 2
        if cp in VIETNAMESE:
            # Keep stacked accents and below-letter dots inside the cell.
            _, top, _, bottom = f.getbbox(ch, anchor='ls')
            assert bottom - top <= height * 2 - 2, 'U+%04X does not fit' % cp
            baseline = max(1 - top, min(baseline, height * 2 - bottom - 1))
        ImageDraw.Draw(im).text((2, baseline), ch, font=f, fill=255, anchor='ls')
        im = im.resize((width, height), Image.Resampling.LANCZOS)
        a = [min(15, (v + 8) // 17) for v in im.tobytes()]
        top = rows = 0
        if crop:   # keep only the rows with ink (at least one): the cell is taller than most letters
            live = [y for y in range(height) if any(a[y * width:(y + 1) * width])] or [0]
            top, rows = live[0], live[-1] - live[0] + 1
            a = a[top * width:(top + rows) * width]
        if len(a) & 1:
            a.append(0)
        packed = bytes((a[i] << 4) | a[i + 1] for i in range(0, len(a), 2))
        if sparse is not None and chr(cp) not in sparse:
            blank = max(blank, len(packed))
            glyphs.append((-1, width, advance, 0, 0))
            continue
        key = (width, advance, top, rows, packed)
        if key not in masks:
            # Glyphs address complete masks by offset, so transparent boundary
            # bytes can be shared without changing any pixels or font metrics.
            leading = len(packed) - len(packed.lstrip(b'\0'))
            trailing = len(data) - len(data.rstrip(b'\0'))
            overlap = min(leading, trailing)
            masks[key] = len(data) - overlap
            data.extend(packed[overlap:])
        glyphs.append((masks[key], width, advance, top, rows))
    if blank:   # shift the real masks past the zero run; skipped glyphs point at its start
        glyphs = [(o + blank, w, a, tp, r) if o >= 0 else (0, w, a, 0, 0) for o, w, a, tp, r in glyphs]
        data = bytes(blank) + data
    return height, data, glyphs


def emit(source, name, height, data, glyphs, extras=()):
    tag = name.removeprefix('ht_pro_')   # the array names Classic has always had: alpha_24, glyphs_24
    source.append(f'static const uint8_t alpha_{tag}[]={{\n')
    source.extend(','.join(str(v) for v in data[i:i + 96]) + ',\n' for i in range(0, len(data), 96))
    source.append('};\n')
    source.append(f'static const ht_pro_glyph_t glyphs_{tag}[]={{\n')
    source.extend('{' + ','.join(map(str, g)) + '},\n' for g in glyphs)
    source.append('};\n')
    if extras:   # the code points baked after the Vietnamese entries, in glyph order (pro_canvas.c code() searches it)
        source.append(f'static const uint16_t extras_{tag}[]={{' + ','.join('0x%04x' % cp for cp in extras) + '};\n')
        table = f'extras_{tag},{len(extras)}'
    else:
        table = '0,0'
    source.append(f'const ht_pro_font_t {name}={{32,255,{height},{len(glyphs)},glyphs_{tag},alpha_{tag},{table}}};\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--font', type=Path,
                    default=SYSTEM_FONT if SYSTEM_FONT.exists() else BUNDLED_FONT)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()

    source = ['/* Generated by scripts/gen_fonts.py. Do not edit or commit. */\n',
              '#include "pro_font_type.h"\n']
    for size in SIZES:
        height, data, glyphs = bake(args.font, size)
        emit(source, f'ht_pro_{size}', height, data, glyphs)
    for name, ttf, size in CONSOLE:
        emit(source, name, *bake(FONTS / ttf, size, sparse_chars=CONSOLE_CUT.get(name, ''), extras=CONSOLE_EXTRA, crop=True), CONSOLE_EXTRA)
    for name, ttf, size in CLASSIC:
        emit(source, name, *bake(FONTS / ttf, size, sparse_chars=CLASSIC_CUT.get(name, ''), extras=CLASSIC_EXTRA, crop=True), CLASSIC_EXTRA)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(''.join(source))


if __name__ == '__main__':
    main()

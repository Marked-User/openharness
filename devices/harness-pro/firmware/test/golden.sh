#!/usr/bin/env bash
# Golden hashes of every Pod screen pod_render draws (dev tool for refactors that must not change a pixel).
#   test/golden.sh           writes the baseline: test/golden.txt, or test/golden-liberation.txt when PRO_FONT is Liberation
#   --skin console           the Console skin: test/golden-console.txt / golden-console-liberation.txt
#   test/golden.sh --check   compares a fresh render with that baseline: exit 0 match, 1 differs, 2 no baseline
# Builds test/pod_render.c the way pod_render.py does, into test/out/golden/.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
out="$here/out/golden"
disp="$fw/main/display"
skin=classic; sfx=""; check=""
while [[ $# -gt 0 ]]; do
    case "$1" in --skin) skin="$2"; shift ;; --check) check=1 ;; esac
    shift
done
if [[ "$skin" == console ]]; then sfx="-console"; out="$here/out/golden-console"; fi
case "${PRO_FONT:-}" in *Liberation*) base="$here/golden$sfx-liberation.txt" ;; *) base="$here/golden$sfx.txt" ;; esac
if [[ -n "$check" && ! -f "$base" ]]; then
    echo "golden: no baseline $base (run test/golden.sh first)" >&2
    exit 2
fi

mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$fw/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
/usr/local/bin/python3 "$fw/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -DHT_FACE_PX=720 -I"$disp" -I"$fw/main" -I"$here/host_stubs" \
   -o "$out/pod_render" "$here/pod_render.c" "$fw"/main/pod/*.c "$fw"/main/pod/classic/*.c "$fw"/main/pod/console/*.c "$disp/pro_canvas.c" "$disp/terminal.c" "$out/pro_fonts.c"

screens=(agent:fw:steps6 agent:cli:qresume tabs tabs:9 tabs:2+3 tabs:linkdown agent:fw:linkdown tab:empty default default:tab default:talk recent chrome chrome:talk tab:{0..5}
    inbox inbox:ask banner:done@0 banner:done@3000 banner:done@5900 banner:failed@0 talk:listen talk:send ota:0 ota:42 ota:100 ota:restart notice:updated notice:failed)
for k in agent recap talk; do
    for id in fw ota be cli web desk docs vault site cur notes2 kilo; do screens+=("$k:$id"); done
done
[[ "$skin" == console ]] && screens=(tabs tabs:bell tabs:mock tabs:0+2 tabs:2+2 recent chrome chrome:talk tabp:3 tabp:1 tabp:8
    agent:fw agent:cli agent:desk agent:kilo agent:fw:long agent:cli:long agent:be:offline agent:fw:banner agent:cli:banner tabs:banner
    recap:desk recap:docs recap:kilo recap:desk:testfail recap:desk:extreme recap:desk:scroll recap:desk:banner
    talk:fw talk:fw:quiet talk:fw:send talk:cur talk:be:send
    inbox inbox:quiet inbox:failed ota:0 ota:62 ota:100 ota:restart)
for s in "${screens[@]}"; do
    for now in 0 600 1234 2500 5000; do
        "$out/pod_render" --skin "$skin" "$s" "$out/r.ppm" "$now" >/dev/null
        echo "$(shasum -a 256 < "$out/r.ppm" | cut -d' ' -f1)  $s@$now"
    done
done | LC_ALL=C sort > "$out/now.txt"

if [[ -z "$check" ]]; then
    cp "$out/now.txt" "$base"
    echo "golden: wrote $(wc -l < "$base" | tr -d ' ') screens to $base"
elif diff "$base" "$out/now.txt" > "$out/diff.txt"; then
    echo "golden: $(wc -l < "$base" | tr -d ' ') screens match"
else
    echo "golden: differing screens:" >&2
    grep '^>' "$out/diff.txt" | awk '{print "  " $3}' >&2
    exit 1
fi

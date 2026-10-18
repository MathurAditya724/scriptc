#!/bin/sh
# Compile every probe in src/ with scriptc, with and without extra flags
# (e.g. --sources), and record coverage, build result and Node parity.
#   sh measure.sh <label> [scriptc flags...]
# Writes results/<label>/<probe>.{coverage,build,node,native}.txt and prints a TSV row per probe.
set -u
here=$(cd "$(dirname "$0")" && pwd)
label=$1
shift
scriptc=${SCRIPTC:-scriptc}
out="$here/results/$label"
mkdir -p "$out" "$here/bin/$label"
printf 'probe\tlabel\tanalyzed\tstatic\tpct\tblockers\tdeferred\tbuild\trun\n'
for src in "$here"/src/*.ts; do
  probe=$(basename "$src" .ts)
  (cd "$here" && node "src/$probe.ts" >"$out/$probe.node.txt" 2>&1; echo "exit=$?" >>"$out/$probe.node.txt")
  (cd "$here" && $scriptc coverage "src/$probe.ts" "$@" >"$out/$probe.coverage.txt" 2>&1)
  analyzed=$(awk '/statements analyzed/ {print $3; exit}' "$out/$probe.coverage.txt")
  static=$(awk '/compile statically/ {print $3; exit}' "$out/$probe.coverage.txt")
  pct=$(awk '/compile statically/ {gsub(/[()%]/, "", $4); print $4; exit}' "$out/$probe.coverage.txt")
  blockers=$(awk '/^  blockers:/ {b=1; next} /^  [a-z]/ {b=0} b && /^ +×[0-9]+/ {sub(/×/, "", $1); n+=$1} END {print n+0}' "$out/$probe.coverage.txt")
  deferred=$(awk '/deferred to runtime/ {print $4; exit}' "$out/$probe.coverage.txt")
  if (cd "$here" && $scriptc build "src/$probe.ts" -o "bin/$label/$probe" "$@" >"$out/$probe.build.txt" 2>&1); then
    build=ok
    (cd "$here" && "./bin/$label/$probe" >"$out/$probe.native.txt" 2>&1; echo "exit=$?" >>"$out/$probe.native.txt")
    if cmp -s "$out/$probe.node.txt" "$out/$probe.native.txt"; then run=match; else run=DIFF; fi
  else
    build=FAIL
    run=-
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$probe" "$label" "${analyzed:--}" "${static:--}" "${pct:--}" "$blockers" "${deferred:-0}" "$build" "$run"
done

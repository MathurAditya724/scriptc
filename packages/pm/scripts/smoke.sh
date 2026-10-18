#!/bin/sh
# End-to-end smoke check: install the public demo app with real pnpm, then run
# `spm sync` under Node and as the scriptc-built native binary, each with a
# cold source cache, and require identical stdout, manifest, lock and overlay
# trees. Needs network access, pnpm, git and a built package
# (`pnpm --filter @scriptc/pm build && pnpm --filter @scriptc/pm build:native`).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
work=${SPM_SMOKE_DIR:-$(mktemp -d)}
mkdir -p "$work"
demo="$work/demo"
rm -rf "$demo" "$work/out-node" "$work/out-native"
cp -R "$repo/examples/spm-demo" "$demo"
rm -rf "$demo/node_modules" "$demo/.scriptc-pm"
(cd "$demo" && pnpm install --silent)

snapshot() {
  out=$1
  mkdir -p "$out"
  cp "$demo/.scriptc-pm/manifest.json" "$demo/scriptc-sources.lock.json" "$out/"
  (cd "$demo/.scriptc-pm/overlay" && find . -type f -o -type l | LC_ALL=C sort | while read -r f; do
    if [ -L "$f" ]; then echo "$f -> $(readlink "$f")"; else echo "$f $(sha256sum "$f" | cut -c1-16)"; fi
  done) >"$out/overlay.txt"
}

run_lane() {
  lane=$1
  shift
  rm -rf "$work/cache-$lane"
  (cd "$demo" && SCRIPTC_PM_CACHE="$work/cache-$lane" "$@" sync >"$work/stdout-$lane.txt" 2>"$work/stderr-$lane.txt") || {
    echo "smoke: $lane lane failed"; cat "$work/stderr-$lane.txt"; exit 1; }
  sed -E 's/ \([0-9.]+s\)$//' "$work/stdout-$lane.txt" >"$work/stdout-$lane.norm"
  snapshot "$work/out-$lane"
}

run_lane node node "$here/dist/main.js"
run_lane native "$here/bin/spm"

status=0
for f in manifest.json scriptc-sources.lock.json overlay.txt; do
  if ! cmp -s "$work/out-node/$f" "$work/out-native/$f"; then
    echo "smoke: $f differs between Node and native"; diff "$work/out-node/$f" "$work/out-native/$f" | head -20; status=1
  fi
done
if ! cmp -s "$work/stdout-node.norm" "$work/stdout-native.norm"; then
  echo "smoke: stdout differs between Node and native"; diff "$work/stdout-node.norm" "$work/stdout-native.norm" | head -20; status=1
fi
augmented=$(grep -c '^augmented' "$work/stdout-node.norm" || true)
if [ "$augmented" -lt 1 ]; then echo "smoke: nothing was augmented"; status=1; fi
cat "$work/stdout-node.txt"
echo "smoke: node $(tail -2 "$work/stdout-node.txt" | head -1 | sed -E 's/.*\(([0-9.]+s)\)$/\1/'), native $(tail -2 "$work/stdout-native.txt" | head -1 | sed -E 's/.*\(([0-9.]+s)\)$/\1/')"
[ "$status" = 0 ] && echo "smoke: OK ($augmented augmented; Node and native outputs identical)"
exit $status

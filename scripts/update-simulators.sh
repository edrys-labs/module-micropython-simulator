#!/usr/bin/env bash
# Copies the hosted MicroPython simulators into simulators/<board>/ and patches them,
# so the module doesn't depend on the hosted sites and starts programs without a click.
#
#   scripts/update-simulators.sh           download, patch and replace the copies
#   scripts/update-simulators.sh --check   only report whether upstream changed (exit 1 if so)
#
# simulators/<board>/UPSTREAM records where the copy came from and the sha256 of the
# unpatched files, which --check compares against. After an update, run the tests and
# commit; `git checkout simulators/` brings the old copies back.
set -euo pipefail

cd "$(dirname "$0")/.."

# board, hosted simulator, repository (for its LICENSE)
BOARDS=(
    "calliope-mini-3 https://simulator.python.calliope.cc/ calliope-edu/micropython-simulator"
    "microbit-v2 https://python-simulator.usermbit.org/v/0.1/ microbit-foundation/micropython-microbit-v2-simulator"
)
FILES=(simulator.html build/firmware.js build/simulator.js build/firmware.wasm)

check=false
if [[ "${1:-}" == "--check" ]]; then
    check=true
elif [[ $# -gt 0 ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The simulator creates its AudioContext only in the click handler of its play button
# and refuses to start a program without one. Browsers allow creating it without a
# click, just suspended, so the patch creates it on start and resumes it on the first
# click or key press on the board.
patch_audio() {
    python3 -I - "$1" <<'EOF'
import sys

path = sys.argv[1]
source = open(path, encoding="utf-8").read()
target = """      if (!this.context) {
        throw new Error("Context must be pre-created from a user event");
      }
"""
patch = """      if (!this.context) {
        // patched by module-micropython-simulator (scripts/update-simulators.sh): start
        // without the play button; the audio stays suspended until a click or key press
        this.context = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 44100
        });
      }
      if (!this.resumeOnInteraction) {
        this.resumeOnInteraction = () => {
          if (this.context && this.context.state === "suspended") {
            this.context.resume();
          }
        };
        document.addEventListener("pointerdown", this.resumeOnInteraction, true);
        document.addEventListener("keydown", this.resumeOnInteraction, true);
      }
"""
count = source.count(target)
if count != 1:
    sys.exit(f"{path}: the code to patch was found {count} times instead of once; upstream changed, update the patch")
open(path, "w", encoding="utf-8").write(source.replace(target, patch))
EOF
}

changed=false
updates=()
for entry in "${BOARDS[@]}"; do
    read -r board url repo <<<"$entry"
    dir="simulators/$board"
    new="$tmp/$board"
    mkdir -p "$new/build"

    for file in "${FILES[@]}"; do
        curl -sSfL -o "$new/$file" "$url$file"
    done

    hashes=$(cd "$new" && sha256sum "${FILES[@]}")
    old_hashes=$(grep -E '^[0-9a-f]{64}  ' "$dir/UPSTREAM" 2>/dev/null || true)
    if [[ "$hashes" == "$old_hashes" ]]; then
        echo "$board: unchanged"
        continue
    fi
    changed=true
    if [[ -z "$old_hashes" ]]; then
        echo "$board: no copy yet"
    else
        echo "$board: upstream differs from the copy (< copy, > upstream):"
        diff <(echo "$old_hashes") <(echo "$hashes") | grep -E '^[<>]' | sed 's/^/    /' || true
    fi

    if $check; then
        continue
    fi

    curl -sSfL -o "$new/LICENSE" "https://raw.githubusercontent.com/$repo/HEAD/LICENSE"
    patch_audio "$new/build/simulator.js"
    {
        echo "Copied from $url (source: https://github.com/$repo) on $(date -u +%Y-%m-%d)"
        echo "by scripts/update-simulators.sh, which patched build/simulator.js."
        echo "sha256 of the files as downloaded, before the patch:"
        echo
        echo "$hashes"
    } >"$new/UPSTREAM"
    updates+=("$board")
done

if $check && $changed; then
    echo "upstream changed: run $0 to update the copies, then the tests"
    exit 1
fi

# only now, once every board downloaded and patched, so a failure changes nothing
for board in "${updates[@]}"; do
    rm -rf "simulators/$board"
    mkdir -p simulators
    cp -r "$tmp/$board" "simulators/$board"
    echo "$board: updated simulators/$board"
done

#!/usr/bin/env bash
#
# Patches server/scheduler.js so that editing a schedule's time or days in the
# UI re-arms the job for today.
#
# The bug: the "already handled today" marker was keyed only on the date, so a
# job marked as past-due at boot stayed suppressed for the rest of the day even
# after you changed its time.
#
# Safe to run twice — it detects an already-patched file and stops.
# Keeps a timestamped backup next to the original.
#
#   ./fix-scheduler.sh                 # then: sudo systemctl restart music-player
#
set -euo pipefail

FILE="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/server/scheduler.js}"

[[ -f "$FILE" ]] || { echo "Not found: $FILE" >&2; echo "Usage: $0 [path/to/scheduler.js]" >&2; exit 1; }

if grep -q 'runKey(now, cfg)' "$FILE"; then
  echo "Already patched — nothing to do."
  exit 0
fi

BACKUP="${FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$FILE" "$BACKUP"
echo "Backup: $BACKUP"

python3 - "$FILE" <<'PY'
import sys

path = sys.argv[1]
src = open(path, encoding='utf-8').read()
before = src

# 1. Add the runKey() helper right after the constructor.
anchor = "    this.timer = null;\n  }\n"
helper = """    this.timer = null;
  }

  /**
   * The "already handled today" marker.
   *
   * Keyed on the schedule as well as the date: editing the time in the UI
   * must re-arm the job. Keying on the date alone meant that changing
   * "22:00" to "16:00" at lunchtime left the morning's boot-time
   * "already past its window" mark in place, silently suppressing the run.
   */
  runKey(now, cfg) {
    return `${now.date}@${cfg.time}@${[...cfg.days].sort().join('')}`;
  }
"""
if anchor not in src:
    sys.exit("Could not find the constructor anchor — file differs from the expected version.")
src = src.replace(anchor, helper, 1)

# 2. Every read and write of the marker uses the composite key.
reads = src.count("this.lastRun.get(job.name) === now.date")
writes = src.count("this.lastRun.set(job.name, now.date)")
src = src.replace("this.lastRun.get(job.name) === now.date",
                  "this.lastRun.get(job.name) === this.runKey(now, cfg)")
src = src.replace("this.lastRun.set(job.name, now.date)",
                  "this.lastRun.set(job.name, this.runKey(now, cfg))")

src = src.replace("this.lastRun = new Map();  // job name -> 'YYYY-MM-DD'",
                  "this.lastRun = new Map();  // job name -> runKey()")

if src == before:
    sys.exit("Nothing changed — file does not match the expected version.")
if reads < 2 or writes < 3:
    sys.exit(f"Unexpected structure (found {reads} reads, {writes} writes). Aborting.")

open(path, 'w', encoding='utf-8').write(src)
print(f"Patched {reads} reads and {writes} writes of the daily marker.")
PY

# Refuse to leave a broken file behind.
if node --check "$FILE" 2>/dev/null || node -e "import('file://$FILE')" 2>/dev/null; then
  echo "Syntax OK."
else
  echo "Patched file failed to parse — restoring backup." >&2
  cp "$BACKUP" "$FILE"
  exit 1
fi

echo
echo "Done. Now restart the service:"
echo "  sudo systemctl restart music-player"

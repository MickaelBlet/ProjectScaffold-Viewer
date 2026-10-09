#!/usr/bin/env bash
# Make the Windows portable Electron exe unpack next to itself instead of %TEMP%, where policies or
# antivirus may block running executables. Patches electron-builder's portable.nsi template in node_modules
# (idempotent); a unique folder per run, %TEMP% kept as fallback when the exe's folder is read-only.
# electron-builder.yml sets `portable.unpackDirName: true` so the template's $TEMP override stays off.
set -euo pipefail
cd "$(dirname "$0")/.."

nsi=node_modules/app-builder-lib/templates/nsis/portable.nsi
marker='GetTempFileName $INSTDIR $EXEDIR'
grep -qF "$marker" "$nsi" && exit 0

sed -i 's|^  StrCpy \$INSTDIR "\$PLUGINSDIR\\app"$|  GetTempFileName $INSTDIR $EXEDIR\n  ${if} $INSTDIR == ""\n    StrCpy $INSTDIR "$PLUGINSDIR\\app"\n  ${else}\n    Delete $INSTDIR\n  ${endIf}|' "$nsi"

grep -qF "$marker" "$nsi" || { echo "patch_portable: $nsi changed, patch not applied" >&2; exit 1; }

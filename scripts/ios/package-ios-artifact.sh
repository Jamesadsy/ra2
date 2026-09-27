#!/usr/bin/env bash
set -euo pipefail

app_path="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output_path="$(mkdir -p "$2" && cd "$2" && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/ra2m1-ipa.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/Payload"
ditto "$app_path" "$stage/Payload/RA2M1.app"
(cd "$stage" && zip -X -qr "$output_path/CnC-RA2-unsigned.ipa" Payload)
ditto -c -k --keepParent "$app_path" "$output_path/CnC-RA2-unsigned.app.zip"

echo "Packaged unsigned, owner-data-free IPA and app archive in $output_path"

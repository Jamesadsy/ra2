# CnC RA2 iPhone host and physical handoff

CnC RA2 is a native iPhoneOS ARM64 app that hosts the public Route B runtime in a WKWebView. Its display name is `CnC RA2`; the bundle identifier and internal app directory remain `org.second-sun.ra2m1` and `RA2M1.app`. The bundled runtime is served offline over a loopback listener at `127.0.0.1:18108`; play does not require an external web server or network connection.

## Files-visible owner data

On first launch, the native host creates `Documents/CnC RA2/Data` and `Documents/CnC RA2/User` so both appear in Files. `Data` accepts a flat, exact eleven-file RA2 M1 device set, including `Maps01.mix` and `Maps02.mix` for the Allied and Soviet campaigns, and verifies the accepted EA 1.08 `game.exe` SHA-256 (`6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d`). The host reads owner data from `Data` in place. It does not recursively import a desktop installation into hidden Application Support, and it does not download or bundle proprietary replacements. Unknown, nested, partial, or wrong-executable sets fail closed.

`User` is a separate Files-visible location for user-owned writable files. Route B's existing save/config/cache behavior remains in the app's persistent WKWebView IndexedDB store; retail inputs are served read-only from `Data`. The app has no iCloud dependency.

The proven private XPS device stage contains exactly 11 files and 1,104,769,197 bytes. It retains the original ten files unchanged and adds only the verified Soviet campaign archive. The full 668-file desktop installation is not the phone Data payload. The local XPS helper copies only the approved device allowlist and validates every file hash, byte length, and the EA 1.08 executable digest before producing a transfer-ready `Data` folder.

## Managed iPhoneOS proof

GitHub Actions workflow `CnC RA2 iOS Host` builds the public Route B runtime, compiles and links an unsigned iPhoneOS `arm64` app, runs asset-free host/custody/WebKit/lifecycle tests, and validates the package. It uses no owner data or signing credentials. The artifact `cnc-ra2-062-apple-proof` contains:

- `CnC-RA2-unsigned.ipa`
- `CnC-RA2-unsigned.app.zip`
- `apple-proof-manifest.json` with exact branch, commit, tree, parent, app identity, and SHA-256 values

The app is unsigned and has no provisioning profile. The public CI checkout, commit, and artifacts contain no retail files.

## Local XPS factory and Chairman procedure

Use `C:\CnC Game Factory Deploy\SS-Deploy-RA2` for the app and IPA factory. The public app payload and unsigned IPA stay owner-data-free. The adjacent local `OWNER-DATA-LOCATION.txt` and `stage-owner-data.ps1` identify and validate the mounted-G transfer set; they are local factory files, not repository content.

After downloading the successful managed artifact for the final source commit, verify its IPA hash against `apple-proof-manifest.json`, place the app archive in `Payload\RA2M1.app`, place the exact managed IPA and manifest in `ipa`, and run `package.cmd`. The factory verifies provenance, the unsigned app identity, the package hashes, and zero owner-data files. Signing and sideloading remain Chairman operations.

After the Chairman installs a signed build, use Files to copy the contents of the curated `Data` transfer folder into `On My iPhone/CnC RA2/Data`. Keep `User` separate and do not transfer the full desktop install. Open CnC RA2 and select **Check Data and start**. The app verifies the folder before starting the original Route B frontend.

The private Windows regression proved the exact curated EA 1.08 set reaches the original frontend, Allied campaign briefing, natural briefing close, playable first battlefield, and continuing simulation. It is not an iPhone physical pass. The Chairman's later physical proof still needs to verify touch-only play, objectives and ordinary mission victory/progression, original score/cutscene/next mission, and one background/foreground cycle.

## Existing save contract

The existing local RA2 save/cold-load test is pinned to a 1.006 startup executable. No EA 1.08 save/cold-load regression is claimed here. This change preserves Route B's current persistent IndexedDB save/config behavior; final save UX is outside this M1 handoff.

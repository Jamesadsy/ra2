# RA2 M1 iPhone host handoff

This candidate uses the accepted Route B browser VM inside a native iPhoneOS ARM64 WKWebView. The app serves only the checked-in, public `dist/` runtime and the app-private owner folder through a read-only listener bound to `127.0.0.1:18108`. It needs no internet connection or external server after installation. A fixed origin keeps the existing WKWebView IndexedDB save/config store stable across launches; retail files live under Application Support and are read-only. The data directory is excluded from backup and is not synced to iCloud.

The native importer accepts the extracted `ra2` directory only after checking all M1 campaign/media files and the exact accepted EA executable SHA-256. It copies into a private staging folder, validates the copy, then promotes the complete set atomically. The app never downloads a replacement executable. The online source path bypasses the legacy third-party 1.006 overlay and verifies the 1.08 digest again before starting Route B.

## Build and public artifact

GitHub Actions workflow `RA2 M1 iOS Host` runs on the implementation branch. It uses no owner data, signing credentials, or retail secrets. It builds the public Route B runtime, compiles and links the iPhoneOS `arm64` app, runs deterministic owner-custody, loopback/WebKit storage, and lifecycle tests on an iPhone simulator, then publishes:

- `RA2M1-iOS-arm64-unsigned.ipa`
- `RA2M1-iOS-arm64-unsigned.app.zip`
- `apple-proof-manifest.json` with branch, HEAD/tree/parent, bundle identity, and SHA-256 values

The bundle is unsigned and contains no provisioning profile. The artifact has only public runtime assets and native host code. The public workflow has no private asset mount or download step.

## XPS owner-data staging

On the Chairman’s XPS, run from the repository checkout after the public build artifact is available:

```powershell
.\scripts\ios\stage-owner-data.ps1
```

By default the helper reads the fresh EA installation from `C:\Program Files\EA Games\Command and Conquer Red Alert II` and writes to `%LOCALAPPDATA%\SecondSunPrivate\RA2-M1`. Both paths can be passed explicitly with `-Source` and `-Destination`. The destination must be on a fixed local XPS drive, outside the repository and configured cloud-sync folders, and must be new or empty. The helper restricts its destination ACL to the current Chairman account, SYSTEM, and local Administrators; rejects symlinks/reparse points; checks the ten required M1 files; verifies the exact `game.exe` digest; copies the complete installation; compares every source/copy file SHA-256; and creates an uncompressed `RA2-OwnerData-1.08.zip`. It never changes the EA source folder.

## Local physical install and import

1. In GitHub, open the successful `RA2 M1 iOS Host` run for the final implementation HEAD and download its `ra2-m1-059-apple-proof` artifact to a local private XPS folder. Verify the downloaded IPA SHA-256 against `apple-proof-manifest.json`.
2. Pass `RA2M1-iOS-arm64-unsigned.ipa` to the existing Chairman-authorized Second Sun iPhone signing/sideload factory on the XPS. The artifact intentionally contains no signing identity. Keep signing credentials and the signed device package on the XPS; no credentials or signed owner package are uploaded back to GitHub or Drive.
3. Transfer `RA2-OwnerData-1.08.zip` to the iPhone through a direct local device-transfer path. In Files, extract the ZIP locally so it contains a top-level `ra2` folder. Keep it On My iPhone; do not use iCloud Drive.
4. Open RA2 M1, tap **Import official EA RA2 1.08 data**, select that extracted `ra2` folder, and wait for the app’s validation and private copy to finish. The first successful import opens the original Route B frontend.
5. Conduct the Chairman physical proof using touch alone: Single Player → Campaign → Allied, original briefing, genuine first mission, ordinary win and real next-mission progression, and one background/foreground cycle. The build does not claim this physical proof has already passed.

The repository’s existing touch layer already provides touch click/selection, long-press secondary action, keyboard/menu controls, and an on-screen directional joystick. The WKWebView is kept alive across app background/foreground. Backgrounding releases held virtual keys and lets Route B's existing `pagehide` save flush run; returning restores the same WebView and the existing audio gesture-unlock hook retries after the next touch. Physical touch play and the full M1 campaign progression remain Chairman-only evidence.

The existing RA2 real save/cold-load regression is tied to the accepted 1.006 startup-page executable hash. This change does not alter Route B save semantics: owner files stay read-only, and writable save/config/cache data remains in the app’s separate persistent IndexedDB overlay. No 1.08 save/cold-load result is claimed until an applicable private test exists.

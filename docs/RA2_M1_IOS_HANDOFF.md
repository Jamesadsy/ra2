# CnC RA2 iPhone host and local factory handoff

The CnC RA2 app uses the accepted Route B browser VM inside a native iPhoneOS ARM64 WKWebView. The installed display name is `CnC RA2`; the technical bundle identifier and internal Xcode product remain `org.second-sun.ra2m1` and `RA2M1.app`. The app serves its bundled public runtime and imported owner folder through a read-only listener at `127.0.0.1:18108`. It needs no internet connection or external server during play. A fixed origin keeps the WKWebView IndexedDB save/config store stable across launches. Retail files live in app-private Application Support, are read-only, excluded from backup, and are not synced by the app to iCloud.

The native importer accepts an extracted `ra2` folder only after checking the required M1 campaign/media files and the accepted EA 1.08 executable SHA-256. It copies to a private staging folder, validates the copy, then promotes the complete set atomically. The app never downloads a replacement executable. The Route B owner-data path verifies the accepted 1.08 digest before starting the game.

## Managed iPhoneOS build

GitHub Actions workflow `CnC RA2 iOS Host` runs only for the accepted implementation branch and its bounded naming/factory refresh. It uses no owner data, signing credentials, or retail secrets. It builds the public Route B runtime, compiles and links the iPhoneOS `arm64` app, runs deterministic owner-custody, loopback/WebKit storage, and lifecycle tests on an iPhone simulator, then publishes:

- `CnC-RA2-unsigned.ipa`
- `CnC-RA2-unsigned.app.zip`
- `apple-proof-manifest.json` with branch, HEAD/tree/parent, app display name, bundle identity, and SHA-256 values

The bundle is unsigned and has no provisioning profile. Its internal bundle directory is `RA2M1.app`; its verified display name is `CnC RA2`. The artifact contains public runtime assets and native host code only. The workflow has no private asset mount or download step.

## Local XPS factory and owner-data custody

Use the local `SS-Deploy-RA2` factory for package convenience. Its `Payload` and `ipa` folders contain only the public app bundle and unsigned package; the packaging helpers read only `Payload` and never read owner files. Follow the adjacent local `OWNER-DATA-LOCATION.txt` and staging helper for the Chairman’s owner-data location and validation procedure. Those local files are not part of Git or the managed artifact.

The app imports a directly selected `ra2` folder, so the local owner-data workflow does not need to create an extra ZIP. Validate the folder against the accepted executable digest and complete M1 inventory before copying it to the device. Keep proprietary files out of Git, GitHub Actions, public artifacts, the app `Payload`, and this repository’s public/source-only build path. The mounted-file-system custody path is documented only in the local factory.

## Local package verification

1. Download the successful `CnC RA2 iOS Host` workflow artifact for the final refresh HEAD into a private XPS staging folder. Compare the IPA SHA-256 to `apple-proof-manifest.json`.
2. Extract the matching `.app.zip` into the local factory `Payload` folder. Keep the internal `RA2M1.app` directory intact; confirm its Info.plist identifies `CnC RA2` and preserves the existing bundle identifier.
3. Copy the exact managed IPA to the local canonical filename `CnC-RA2-unsigned.ipa`, then run the factory `package.cmd` once. The helper verifies the payload contains one unsigned, owner-data-free app and that its app files match the package. If ZIP metadata changes the repackaged hash, it preserves the exact managed IPA as the canonical physical-test package and records the generated package identity locally.
4. The later Chairman physical test imports the validated owner folder in-app, then checks campaign flow, original briefing, genuine first battlefield, ordinary mission win/progression, touch controls, and one background/foreground cycle. This source/factory refresh does not perform iPhone operations or claim the physical proof has passed.

The existing touch layer provides touch click/selection, long-press secondary action, menu controls, and an on-screen directional joystick/camera control. The WKWebView is kept alive across app background/foreground. Backgrounding releases held virtual keys and allows Route B's existing `pagehide` save flush; returning restores the same WebView, and the audio gesture-unlock hook retries after the next touch. Physical touch play and full campaign progression remain device evidence.

The existing RA2 real save/cold-load regression is tied to the accepted 1.006 startup-page executable hash. This naming/factory refresh does not alter Route B save semantics: owner files stay read-only, and writable save/config/cache data remains in the app's separate persistent IndexedDB overlay. No EA 1.08 save/cold-load result is claimed until an applicable private test exists.

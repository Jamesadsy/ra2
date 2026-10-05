# RA2 079 post-cameo diagnostics

RA2 079 adds bounded observations to the exact 075 source line. It does not change audio, DirectSound, lifecycle, Worker ownership, Bink routing, scheduling, input, or game behavior.

`ExecutionProgressTracker` records the sequence and monotonic age of guest frame submissions, hypercalls since the last submission, the last hypercall and guest return address, and the most common identities in a fixed 64-call window. Identity strings are capped at 64 characters, the top list at six entries, and counters saturate at 32 bits. Each VM owns a fresh tracker; `reset()` clears every field and is covered by a deterministic unit test.

The existing `getDiagnostics` request/reply carries these values alongside the host frame counters already recorded by Performance Diagnostics. The Win32 snapshot reads current Bink open/close generations, active/close-return/pin state, callback depth, pending guest deadlines, owned sound-buffer count, and up to four copies of the existing bounded streaming traces. Trace records contain scalar metadata only; they do not include PCM, media bytes, paths, or owner Data.

## Preserve a physical wedge capture

After both known battlefield cameos have established and speech has advanced normally, keep the app foregrounded after the second cameo and continue through the OBS-SS-045 failure window. If guest frames stop while the host remains responsive, use the existing **Performance Diagnostics** toolbar entry and complete its 20-second capture while the wedge is present. Tap **Copy report** and paste the JSON report into the `COMP-SS-LUNA-085` physical-evidence section. This existing capture uses the existing diagnostic RPC; it adds no VM message or recovery action.

Also retain the newest `User/Debug/DEBUG_*.LOG` and `User/LastLaunchDiagnostics.txt` from the app's Files-visible `User` folder. Those files retain the existing native and streaming metrics, including `producerCursorUncached` and bounded stream-trace fields when emitted. Preserve only diagnostic text; do not copy or attach the sibling `Data` folder, media, PCM, or game files. A missing reproduction is not evidence that the wedge was fixed.

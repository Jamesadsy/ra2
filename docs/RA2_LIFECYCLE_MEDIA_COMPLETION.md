# Lifecycle recovery and media completion ownership

## Foreground recovery

The native host quiesces on will-resign-active (did-enter-background is an idempotent fallback). Will-enter-foreground records preparation; did-become-active dispatches the foreground edge to the retained WKWebView. The browser coordinator serializes guest pause/resume and tracks signal generations before asynchronous work completes.

Backgrounding invalidates the audio recovery generation. Automatic/native and visibility paths cannot reconstruct a pending graph. The first trusted pointer, touch or key event owns one promise for that generation. Fresh-context policy replaces the context only on this event stack, closes the old context, starts retained sources and invokes resume without an unawaited suspend/resume pair. Same-context policy preserves the context. Stale context/generation completions cannot rebuild playback or clear pending recovery; stale coordinator completions cannot show a restart overlay.

Context state alone never proves pending recovery. The context clock must progress, and every retained live stream must produce a new renderer report. Script processors publish after rendering and Worklets publish from audio processing. A static retained source requires a progressing context clock. The bounded observation deadline reports genuine authoritative failure; it does not reset the guest. Current-generation failure still fails closed.

## Demonstrated media completion defect

The accepted producer cache bypass remains unchanged. Completion previously allowed a stopped buffer's guest cursor to be overridden by renderer state. Separately, the Worker cleared a reader on Stop/Release but accepted a late reader packet without a buffer-lifetime identity; a retired shared cursor could be rebound to a reused guest address. An authoritative frozen reader suppresses monotonic fallback and keeps GetCurrentPosition constant while the guest continues polling.

Stop/SetCurrentPosition now own stopped cursor truth. Playing buffers retain the accepted shared-reader behavior, including intentionally frozen consumption when the renderer does not progress. Worker-owned lifetime numbers travel with create, duplicate, format, stop and play operations and with returned reader/cursor packets. Packets crossing retirement are rejected. Release and stop-all invalidate their old lifetime. Final stopped Lock/Unlock only updates PCM; it cannot restart rendering.

The synthetic x86 completion contract reproduces the no-frame/high-hypercall class: event one returns to a frame; a late stopped cursor at event two causes a GetCurrentPosition loop with no second frame. The pre-fix run observed 318,200 hypercalls in its bounded failure window, one submitted frame and cursor 1,024. With stopped-cursor ownership, both events return, simulation counters advance, key state is read, two DirectDraw frames submit and all buffers/traces retire. This is original test code, not a reconstructed proprietary game callback. The Chairman capture did not include the exact import identity/return address, so correlation of this demonstrated mechanism with that physical instance remains unconfirmed.

A private read-only native-instruction oracle also executed the original Bink ready, service, Lock/Unlock, stop/reset/final-fill and backend close functions with synthetic decoded PCM for two sequential events. The accepted producer policy advanced source offsets 4,096 through 12,288 twice; the old cache policy remained at 4,096. Both backend closes cleared their buffer pointers, sink resources and traces. No decoder, owner bytes or oracle binary enters the repository/artifact. Full native video decoding and the proprietary guest event-return path remain physical acceptance scope.

## Trace and diagnostic limits

Bink Open and Close remain host boundaries. Wait/DoFrame/NextFrame and other high-frequency methods retain original DLL routing during native playback. Close restores cached/static export stubs and retires pacing deadlines; the existing atomic guest bridge protects cleanup and releases the lifetime pin. These behaviors were traced and retained rather than replaced by a media timeout. No broad scheduling or Bink patch is introduced.

On-demand VM captures add bounded top hypercall identities since the last guest frame, the last call's guest return address, media completion generation, native-active/close-pending/pin state, routed callbacks and owned sound-buffer counts. `activeWithoutFrameProgress` classifies a running guest with at least 512 calls and two seconds without a submitted guest frame. It is diagnostic only: it never suppresses a failure, changes media duration, alters clocks or restarts the app. Presentation ACK counts and actual simulation counters remain separate observations.

Synthetic silence and simulator output cannot establish audible target-cameo continuity or confirm the precise physical root cause. Chairman testing must verify both accepted speech and post-second-event gameplay, with the enhanced capture retained on any stall.

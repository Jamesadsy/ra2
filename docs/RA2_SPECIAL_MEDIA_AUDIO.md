# RA2 special-media audio advancement

RA2's injected `uncachedAudioProducerDlls` policy classifies secondary DirectSound buffers created by an immediate caller inside the already loaded `binkw32.dll` image. Their guest cursor-cache budget stays zero from creation, before the first playing overwrite. Primary buffers, unknown callers, unloaded modules and ordinary producers retain the existing policy. Duplicates inherit producer ownership. Stop, seek and restart preserve it; Release removes the buffer and trace.

## Failure mechanism

The accepted Bink 1.0p DLL uses four explicit refill segments. Its ready callback compares the consumed segment with the previous segment. Only a changed segment permits Lock/copy/Unlock and advancement of decoded source bytes. These Locks use flags zero: observing `DSBLOCK_FROMWRITECURSOR` cannot identify this producer.

Before the first playing overwrite, the browser sink plays the initial prefill through its static source. That first overwrite activates the shared renderer. A 1,023-call guest cursor cache can prevent the first refill which would activate the reader that bypasses the cache. At Bink's service cadence this is not a frame-sized delay: the initial ring repeats while the decoded source remains unchanged.

The repair exposes initial consumer observations to this producer. It does not manufacture cursor progress, change explicit Lock origins, relax thread pinning, replace decoding or infer consumption from wall time. A frozen consumer remains frozen. Subsequent shared-reader state continues to publish actual consumed frames.

## Native path evidence

Read-only inspection used accepted `BINKW32.DLL`, SHA-256 `1FD7EF7873C8A3BE7E2F127B306D0D24D7D88E20CF9188894EFF87B5AF0D495F`. These virtual addresses apply to that image at base `0x10000000` only.

- `_BinkSetSoundSystem@8` (`0x10007e50`) registers the callback returned by `_BinkOpenDirectSound@4` (`0x1002a940`). `_BinkOpen@8` is `0x10007f00`.
- The backend creates a four-segment secondary ring with flags `0x180e0`, prefills before Play, and services ready/Lock/Unlock through `0x1002aec0`, `0x1002b180` and `0x1002b1d0`.
- Readiness at `0x1002b150` uses GetCurrentPosition. Lock at `0x1002b0a0` uses explicit segment offsets, flags zero.
- Service at `0x10008bb0` advances source pointer handle `+0x294` and decreases remaining decoded bytes at `+0x29c` only after readiness, wrapping between `+0x288` and `+0x28c`.
- `_BinkWait@4` (`0x1000a3c0`) calls service at `0x1000a424`; `_BinkDoFrame@4` (`0x10009bc0`) calls it at `0x10009d67`. `_BinkNextFrame@4` is `0x1000a0c0`; `_BinkClose@4` is `0x1000a2e0`.

Existing registration, pre-entry initialization, static/dynamic native export routing, NOTHREADEDIO policy, atomic guest calls and Close restoration remain. Wait and DoFrame service audio on the pinned calling thread; advancement does not require relaxing the native lifetime pin. Worker samples and synchronous reader state use the existing audio bridge. Browser Stop/Release retires the renderer.

A task-local real-v86 oracle executed original ready/Lock/Unlock/service code with synthetic decoded PCM through the production COM bridge. With the old policy, nine calls left source position at 4,096 bytes and remaining bytes at 28,672. With the repair, source positions were 4,096, 5,120, 6,144, 7,168, 8,192, 9,216, 10,240, 11,264 and 12,288; remaining bytes decreased by 1,024 per refill. Explicit origins traversed two wraps. No owner media was decoded or redistributed. This does not prove physical audibility.

## Donor reconciliation

No donor decoder/runtime was integrated. Exact inspected revisions:

| Project               | Commit                                     | Evidence used                                                                                                                                                                 |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AgentMystia/openyrweb | `72344c29daea9e3cb825c94e70ae90f6e7966baf` | `src/engine/gameRes/VideoConverter.ts.js` strips audio with `-an`; conversion cannot repair this native producer.                                                             |
| FFmpeg/FFmpeg         | `67c9eaccfe87043e7798b65df78c447264674286` | `libavformat/bink.c` advances separate audio timestamps by decoded sample count; `libavcodec/binkaudio.c` retains overlap/first-block state. Service is not an implicit seek. |
| wine-mirror/wine      | `455e3509b98a6919fd4ad1def4803e08c41c03b2` | `dlls/dsound/buffer.c` observes playback/mix state and distinguishes explicit Lock offsets from FROMWRITECURSOR.                                                              |
| danoon2/Boxedwine     | `509f6a7545e0827a27ed1b4ebab66ac1da4b1ea7` | `project/emscripten/boxedwine-audio-worklet.js` publishes reader progress after PCM copy and advances producer writes by copied counts.                                       |

## Regression contract and limits

`tests/basic/vm/specialMediaAudio.e2e.test.ts` executes the x86 cached position stub with main/Worker-style observations, two ring wraps, explicit split Locks, frozen consumption, bounded classification, duplicates and restart/Release. Its generated PE contains original test instructions, no decoder/owner bytes. Ordinary producers retain the 1,023-call budget.

`tests/basic/browser/specialMediaAudioBrowserSmoke.mts` prefills four segments before Play, requires no reader before first refill, observes eight segment transitions with zero budget, and checks reader activation and Stop/Release retirement. It uses synthetic silence and never invalidates the cache through GetStatus to obtain progress.

Bounded diagnostics add `producerCursorUncached` (native scalar 0/1) to existing cursor/cache/refill observations, without PCM or owner paths. The same top-right cameo, audible speech continuity, normal event end and subsequent ordinary music/SFX require Chairman physical testing.

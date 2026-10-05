import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const expectedBranch = 'secondsun/ra2-m1-ios-079-075-post-cameo-diagnostics';
const expectedBase = '312e8a79d93c133992057663d8a85f71023c2008';
const expectedBaseTree = '18d0b06ef512866c8228df3498043a6c608afb4b';
const run = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const branch = run(['branch', '--show-current']);
const head = run(['rev-parse', 'HEAD']);
const parent = run(['rev-parse', 'HEAD^']);
const baseTree = run(['rev-parse', `${expectedBase}^{tree}`]);

if (branch !== expectedBranch) throw new Error(`Unexpected RA2 079 branch: ${branch}`);
if (parent !== expectedBase)
  throw new Error(`RA2 079 must be one commit directly on protected 075 HEAD ${expectedBase}; found parent ${parent}.`);
if (baseTree !== expectedBaseTree) throw new Error(`Protected 075 tree mismatch: ${baseTree}`);

const remoteBase = run([
  'ls-remote',
  'origin',
  'refs/heads/secondsun/ra2-m1-ios-075-sol-high-bink-cameo-recovery',
]).split(/\s+/)[0];
if (remoteBase !== expectedBase) throw new Error(`Protected 075 branch moved or changed: ${remoteBase || 'missing'}`);

const allowedPaths = new Set([
  '.github/workflows/ra2-m1-ios-059.yml',
  'docs/RA2_079_POST_CAMEO_DIAGNOSTICS.md',
  'ios/RA2M1/Sources/RuntimeDiagnostics.swift',
  'ios/RA2M1/SourcesTests/RuntimeLifecycleTests.swift',
  'scripts/ios/proveRa2079Diagnostics.mjs',
  'scripts/ios/verifyAppleApp.mjs',
  'src/adapter/executionProgress.ts',
  'src/adapter/vmCore.ts',
  'src/adapter/vmDiagnostics.ts',
  'src/vm86/win32.ts',
  'tests/basic/capturePerformance.test.ts',
  'tests/basic/executionProgress.test.ts',
  'tests/basic/vm/specialMediaAudio.e2e.test.ts',
  'tests/basic/vmClient.test.ts',
  'tests/basic/vmCore.test.ts',
  'tests/basic/vmWorkerController.test.ts',
]);
const changedPaths = run(['diff', '--name-only', expectedBase, head]).split(/\r?\n/).filter(Boolean);
const unexpectedPaths = changedPaths.filter((path) => !allowedPaths.has(path));
if (unexpectedPaths.length)
  throw new Error(`Changes outside the diagnostics-only allowlist: ${unexpectedPaths.join(', ')}`);

const frozenPaths = [
  'src/adapter/audio.ts',
  'src/adapter/audioReader.ts',
  'src/adapter/pcmStreamWorklet.js',
  'src/adapter/runtimeLifecycleCoordinator.ts',
  'src/adapter/vmLifecycle.ts',
  'src/adapter/vmClient.ts',
  'src/adapter/vmProtocol.ts',
  'src/adapter/vmWorkerController.ts',
  'ios/RA2M1/Sources/HostViewController.swift',
  'ios/RA2M1/Sources/RuntimeLifecycle.swift',
  'src/vm86/shim/directx.ts',
  'src/games/ra2/profile.ts',
  'src/vm86/shim/gameProfile.ts',
];
execFileSync('git', ['diff', '--exit-code', expectedBase, head, '--', ...frozenPaths], { cwd: repository });

console.log(
  JSON.stringify(
    { branch, head, parent, base: expectedBase, baseTree, changedPaths, frozenProductionPaths: 'byte-identical' },
    null,
    2,
  ),
);

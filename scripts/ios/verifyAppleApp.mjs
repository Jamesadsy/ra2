import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const base = process.env.ACCEPTED_BASE_SHA ?? 'f25986bb1821043ce4f3bbf3f7637330014628dd';
const [appPath, outputDirectory] = process.argv.slice(2).map((path) => resolve(path));
if (!appPath || !outputDirectory) throw new Error('Usage: verifyAppleApp.mjs <RA2M1.app> <artifact-output-directory>');

const run = (command, args) => execFileSync(command, args, { cwd: repository, encoding: 'utf8' }).trim();
const fail = (message) => {
  throw new Error(message);
};
const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')]));
if (plist.CFBundleIdentifier !== 'org.second-sun.ra2m1') fail('Unexpected app bundle identifier.');
if (plist.CFBundleDisplayName !== 'CnC RA2' || plist.CFBundleName !== 'CnC RA2') {
  fail(`Expected CnC RA2 app display identity, got ${plist.CFBundleDisplayName}/${plist.CFBundleName}.`);
}
if (!plist.CFBundleSupportedPlatforms?.includes('iPhoneOS')) fail('The app bundle is not an iPhoneOS build.');
if (
  await stat(appPath)
    .then((value) => !value.isDirectory())
    .catch(() => true)
)
  fail('RA2M1.app is missing.');

const executable = join(appPath, plist.CFBundleExecutable);
const architectures = run('/usr/bin/lipo', ['-archs', executable]).split(/\s+/);
if (!architectures.includes('arm64')) fail(`iPhoneOS executable lacks arm64: ${architectures.join(', ')}`);
if (
  await stat(join(appPath, '_CodeSignature'))
    .then(() => true)
    .catch(() => false)
)
  fail('Unsigned artifact contains _CodeSignature.');
if (
  await stat(join(appPath, 'embedded.mobileprovision'))
    .then(() => true)
    .catch(() => false)
)
  fail('Unsigned artifact contains a provisioning profile.');

const bannedExtension = new Set(['.exe', '.dll', '.mix', '.csf', '.fnt']);
const bannedName = new Set([
  'game.exe',
  'ra2.exe',
  'gamemd.exe',
  'ra2.mix',
  'language.mix',
  'binkw32.dll',
  'blowfish.dll',
  'maps01.mix',
  'movies01.mix',
  'movies02.mix',
  'multi.mix',
  'theme.mix',
]);
const files = [];
async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const absolute = join(folder, entry.name);
    if (entry.isSymbolicLink()) fail(`App artifact contains a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) await visit(absolute);
    else {
      const name = entry.name.toLowerCase();
      if (bannedName.has(name) || bannedExtension.has(extname(name)))
        fail(`Owner retail data is present in the app bundle: ${entry.name}`);
      files.push(absolute);
    }
  }
}
await visit(appPath);
if (!files.includes(executable)) fail('App executable was not found in the bundle inventory.');

const tracked = run('git', ['ls-files']).split(/\r?\n/).filter(Boolean);
const untrackedPrivate = ['game/ra2/game.exe', 'game/ra2/ra2.mix', 'game/ra2/language.mix'].filter((path) =>
  tracked.includes(path),
);
if (untrackedPrivate.length) fail('Private owner-data paths are tracked by Git.');
const changed = run('git', ['diff', '--name-only', `${base}...HEAD`])
  .split(/\r?\n/)
  .filter(Boolean);
if (changed.some((path) => /^(game\/|\.tmp-third-party\/)|\.(exe|dll|mix|csf|fnt)$/i.test(path))) {
  fail('A changed Git path resembles a proprietary owner-data payload.');
}

const branch = run('git', ['branch', '--show-current']);
const head = run('git', ['rev-parse', 'HEAD']);
const tree = run('git', ['rev-parse', 'HEAD^{tree}']);
const parent = run('git', ['rev-parse', 'HEAD^']);
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const appHash = createHash('sha256');
for (const path of files.sort()) {
  appHash.update(path.slice(appPath.length));
  appHash.update(await hashFile(path));
}
const appBundleHash = appHash.digest('hex');
const ipaSha256 = await hashFile(join(outputDirectory, 'CnC-RA2-unsigned.ipa'));
const appArchiveSha256 = await hashFile(join(outputDirectory, 'CnC-RA2-unsigned.app.zip'));
const summary = {
  artifact: 'CnC-RA2-unsigned',
  displayName: plist.CFBundleDisplayName,
  appBundleDirectoryName: basename(appPath),
  branch,
  head,
  tree,
  parent,
  acceptedBase: base,
  workflowRunId: runId,
  workflowRunAttempt: runAttempt,
  bundleIdentifier: plist.CFBundleIdentifier,
  platform: plist.CFBundleSupportedPlatforms,
  architectures,
  signing: 'unsigned; no provisioning profile',
  fileCount: files.length,
  appBundleContentSHA256: appBundleHash,
  ipaSHA256: ipaSha256,
  appArchiveSHA256: appArchiveSha256,
  ownerDataFiles: 0,
};

const output = resolve(outputDirectory);
await (await import('node:fs/promises')).mkdir(output, { recursive: true });
await writeFile(join(output, 'apple-proof-manifest.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

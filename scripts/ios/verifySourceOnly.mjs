import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tracked = execFileSync('git', ['ls-files'], { cwd: repository, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const forbiddenTracked = tracked.filter((path) =>
  /(^|\/)(?:game\/ra2|\.tmp-third-party)(?:\/|$)|\.(?:exe|dll|mix|csf|fnt)$/i.test(path),
);
if (forbiddenTracked.length)
  throw new Error(`Proprietary owner-data paths are tracked: ${forbiddenTracked.join(', ')}`);

for (const relative of [
  'game/ra2/game.exe',
  'game/ra2/ra2.mix',
  'game/ra2/language.mix',
  '.tmp-third-party/game.exe',
]) {
  if (existsSync(resolve(repository, relative)))
    throw new Error(`Public Apple build checkout contains private owner data at ${relative}`);
}
console.log(
  `Source-only checkout verified at ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()}.`,
);

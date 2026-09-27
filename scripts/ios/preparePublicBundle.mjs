import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const source = resolve(repository, 'dist');
const destination = resolve(repository, 'ios/RA2M1/Resources/Web');

if (!existsSync(resolve(source, 'index.html'))) throw new Error('Build the public Route B dist/ runtime first.');
if (!destination.startsWith(`${resolve(repository, 'ios/RA2M1')}${sep}`)) {
  throw new Error('The generated Web bundle path escaped the iOS app resource directory.');
}
if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
mkdirSync(resolve(destination, '..'), { recursive: true });
cpSync(source, destination, { recursive: true, errorOnExist: true });
console.log(`Prepared public Route B bundle (${destination.split(sep).slice(-3).join('/')}).`);

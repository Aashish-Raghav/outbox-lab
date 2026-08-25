#!/usr/bin/env node
/**
 * Boots the whole stack with one command.
 *
 * `npm run dev --workspaces` cannot do this: it runs workspace scripts in
 * series, so it would block forever on the first watcher and never reach the
 * API or the dashboard.
 *
 * Order matters. `@reachinbox/shared` publishes `dist/index.js`, so the API —
 * which runs through tsx and resolves the package normally — needs it to exist
 * before it starts. A fresh clone has no `dist`, so the build runs once
 * up front, and only then do the three long-running processes start.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const COLOURS = { shared: '\x1b[35m', api: '\x1b[36m', web: '\x1b[32m' };
const RESET = '\x1b[0m';

function label(name) {
  const colour = COLOURS[name];
  const tag = `[${name.padEnd(6)}]`;
  return colour ? `${colour}${tag}${RESET}` : tag;
}

/** Prefixes every line so three interleaved log streams stay readable. */
function pipe(name, stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${label(name)} ${line}\n`);
  });
}

function run(name, args) {
  const child = spawn(npm, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  pipe(name, child.stdout);
  pipe(name, child.stderr);
  return child;
}

async function buildShared() {
  process.stdout.write(`${label('shared')} building the shared contract package…\n`);

  const code = await new Promise((done) => {
    const child = run('shared', ['run', 'build', '-w', '@reachinbox/shared']);
    child.on('exit', done);
  });

  if (code !== 0) {
    process.stdout.write(`${label('shared')} build failed, not starting anything else\n`);
    process.exit(code ?? 1);
  }
}

await buildShared();

const children = [
  run('shared', ['run', 'dev', '-w', '@reachinbox/shared']),
  run('api', ['run', 'dev', '-w', '@reachinbox/api']),
  run('web', ['run', 'dev', '-w', '@reachinbox/web']),
];

let shuttingDown = false;

/**
 * One dead child brings the others down. Leaving a web server running against
 * a crashed API produces confusing "why is everything 500" debugging.
 */
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${label('dev')} ${reason} — stopping\n`);
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const child of children) {
  child.on('exit', (code) => shutdown(`a process exited (${code})`));
}

process.on('SIGINT', () => shutdown('interrupted'));
process.on('SIGTERM', () => shutdown('terminated'));

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
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * The repo keeps one `.env` at the root so the API, the worker and the scripts
 * cannot drift apart. Next, however, only reads `.env` files inside `apps/web`,
 * so without this the dashboard would silently ignore the root file — most
 * visibly `API_ORIGIN`, which is where it proxies `/api/*`.
 *
 * Values already in the real environment win, matching the API's own loader,
 * so `API_ORIGIN=… npm run dev` still overrides the file.
 */
function rootEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return { ...process.env };

  const merged = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;

    let value = match[2];
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    merged[match[1]] = value;
  }

  return { ...merged, ...process.env };
}

const childEnv = rootEnv();

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

/**
 * `detached: true` makes each child a process-group leader, so shutdown can
 * signal the whole group.
 *
 * Without it, `npm run dev -w web` is three processes deep — npm, then `sh -c
 * next dev`, then the actual `next-server` — and signalling only the child we
 * hold a handle to leaves `next-server` orphaned and still holding :3000. The
 * next `npm run dev` then dies with EADDRINUSE from a server nothing appears to
 * own.
 */
function run(name, args) {
  const child = spawn(npm, args, {
    cwd: root,
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(name, child.stdout);
  pipe(name, child.stderr);
  return child;
}

/** Signals a child's entire process group, tolerating one that already exited. */
function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone. Nothing to do.
    }
  }
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

/**
 * Fails with a readable message instead of Next's raw EADDRINUSE stack, which
 * says nothing about what to do next — usually "a previous `npm run dev` is
 * still running in another terminal".
 */
async function checkPort(port, who) {
  const free = await new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    // No host: Node binds dual-stack `::`, so this collides with an existing
    // listener whether it took the IPv4 or the IPv6 address. Naming a host
    // would miss half the cases — Next binds `::`, the API binds 0.0.0.0.
    probe.listen(port);
  });

  if (!free) {
    process.stdout.write(
      `${label('dev')} port ${port} is already in use, so the ${who} cannot start.\n` +
        `${label('dev')} Another \`npm run dev\` is probably running. Stop it, or:\n` +
        `${label('dev')}   pkill -f dev.mjs\n`,
    );
    process.exit(1);
  }
}

await checkPort(Number(childEnv.PORT ?? 4000), 'API');
await checkPort(3000, 'dashboard');

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
  for (const child of children) killTree(child, 'SIGTERM');

  // Anything still alive after the grace period gets SIGKILL, so a wedged Next
  // build cannot leave :3000 occupied after this process is gone.
  setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL');
    process.exit(0);
  }, 3000).unref();
}

for (const child of children) {
  child.on('exit', (code) => shutdown(`a process exited (${code})`));
}

process.on('SIGINT', () => shutdown('interrupted'));
process.on('SIGTERM', () => shutdown('terminated'));

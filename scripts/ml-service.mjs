// Starts the rain forecast confidence service (ml-service/) on any OS: finds Python 3.12+, creates ml-service/.venv on first run,
// installs requirements.txt when it changes, then runs uvicorn on 127.0.0.1:8001 (ML_PORT overrides the port).
// `npm run dev` runs it with --optional: if anything is missing (Python, models) or the service stops, it says so and stays idle,
// so the website and backend keep running without the confidence line instead of being shut down with it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ML = fileURLToPath(new URL('../ml-service/', import.meta.url));
const VENV = join(ML, '.venv');
const WINDOWS = process.platform === 'win32';
const venvPython = join(VENV, WINDOWS ? 'Scripts/python.exe' : 'bin/python');
const port = process.env.ML_PORT || '8001';
const optional = process.argv.includes('--optional');

// Keeps an optional launcher alive (concurrently would otherwise stop the website when it exits) until Ctrl+C.
function idle() {
  setInterval(() => {}, 1 << 30);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

function fail(message) {
  console.error(`[ml] ${message}`);
  if (!optional) process.exit(1);
  console.error('[ml] The website keeps running; rain alerts are sent without the confidence line.');
  idle();
  throw new Stop();
}

class Stop extends Error {}

function run(command, args, hint = '') {
  const result = spawnSync(command, args, { cwd: ML, stdio: 'inherit' });
  if (result.status !== 0) fail(`"${command} ${args.join(' ')}" failed.${hint}`);
}

// Windows refuses paths over 260 characters unless long paths are enabled; numpy's files are deep enough to hit it from a long folder.
const LONG_PATH_HINT = WINDOWS
  ? ' If the error says "filename or extension is too long", move the project to a shorter folder (for example C:\\projects\\)'
    + ' or enable Windows long paths, then delete ml-service/.venv and run this again.'
  : '';

// The first stable Python 3.12+ on this machine (numpy and scipy, which the model needs, require 3.12). Pre-releases are skipped:
// the Windows launcher's plain "py -3" picks the newest install even when it is a beta, and the service crashes on one.
function findPython() {
  const candidates = WINDOWS
    ? [['python', []], ...['3.14', '3.13', '3.12'].map((version) => ['py', [`-${version}`]]), ['py', ['-3']], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; v = sys.version_info; print(v.major, v.minor, v.releaselevel)'], { encoding: 'utf8' });
    const [major, minor, level] = (probe.stdout ?? '').trim().split(' ');
    if (probe.status === 0 && level === 'final' && (Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 12))) return [command, prefix];
  }
  return null;
}

async function alreadyRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function start() {
  if (await alreadyRunning()) {
    console.log(`[ml] A rain confidence service is already running on http://127.0.0.1:${port}; using it.`);
    if (optional) idle();
    return;
  }

  const models = ['heavy_rain_rf.joblib', 'moderate_rain_rf.joblib'].filter((name) => existsSync(join(ML, 'models', name)));
  if (!models.length) fail('No model files in ml-service/models/. Pull them from git, or rebuild them (see ml-service/README.md).');

  if (!existsSync(venvPython)) {
    const python = findPython();
    if (!python) fail('A stable Python 3.12 or newer is required (not a beta). Install it from https://www.python.org/downloads/ and run this again.');
    console.log('[ml] Creating ml-service/.venv (first run only)...');
    run(python[0], [...python[1], '-m', 'venv', VENV]);
  }

  // Reinstall only when requirements.txt changed since the last install.
  const requirements = readFileSync(join(ML, 'requirements.txt'));
  const stamp = join(VENV, '.requirements.sha256');
  const hash = createHash('sha256').update(requirements).digest('hex');
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash) {
    console.log('[ml] Installing Python packages (a few minutes the first time)...');
    run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements.txt'], LONG_PATH_HINT);
    writeFileSync(stamp, hash);
  }

  console.log(`[ml] Rain confidence service on http://127.0.0.1:${port} (models: ${models.join(', ')})`);
  const service = spawn(venvPython, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', port, '--log-level', 'warning'], { cwd: ML, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { service.kill(signal); process.exit(0); });
  service.on('exit', (code) => {
    if (!optional) process.exit(code ?? 0);
    console.error(`[ml] The service stopped (exit code ${code}). The website keeps running; rain alerts are sent without the confidence line.`);
    idle();
  });
}

start().catch((error) => {
  if (error instanceof Stop) return;
  try {
    fail(error.message);
  } catch {
    // fail() already printed the message and, in optional mode, keeps the process idle.
  }
});

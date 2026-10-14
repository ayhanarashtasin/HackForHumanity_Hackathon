// Starts the rain forecast confidence service (ml-service/) on any OS: finds Python 3.12+, creates ml-service/.venv on first run,
// installs requirements.txt when it changes, then runs uvicorn on 127.0.0.1:8001 (ML_PORT overrides the port).
// The backend uses it when server/.env sets ML_SERVICE_URL=http://127.0.0.1:8001; alerts work the same without it.
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

function fail(message) {
  console.error(`[ml] ${message}`);
  process.exit(1);
}

function run(command, args, hint = '') {
  const result = spawnSync(command, args, { cwd: ML, stdio: 'inherit' });
  if (result.status !== 0) fail(`"${command} ${args.join(' ')}" failed.${hint}`);
}

// Windows refuses paths over 260 characters unless long paths are enabled; numpy's files are deep enough to hit it from a long folder.
const LONG_PATH_HINT = WINDOWS
  ? ' If the error says "filename or extension is too long", move the project to a shorter folder (for example C:\\projects\\)'
    + ' or enable Windows long paths, then delete ml-service/.venv and run this again.'
  : '';

// The first Python 3.12+ on this machine (numpy and scipy, which the model needs, require 3.12).
function findPython() {
  const candidates = WINDOWS ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
    const [major, minor] = (probe.stdout ?? '').trim().split(' ').map(Number);
    if (probe.status === 0 && (major > 3 || (major === 3 && minor >= 12))) return [command, prefix];
  }
  return null;
}

const models = ['heavy_rain_rf.joblib', 'moderate_rain_rf.joblib'].filter((name) => existsSync(join(ML, 'models', name)));
if (!models.length) fail('No model files in ml-service/models/. Pull them from git, or rebuild them (see ml-service/README.md).');

if (!existsSync(venvPython)) {
  const python = findPython();
  if (!python) fail('Python 3.12 or newer is required. Install it from https://www.python.org/downloads/ and run this again.');
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
const service = spawn(venvPython, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', port], { cwd: ML, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.kill(signal));
service.on('exit', (code) => process.exit(code ?? 0));

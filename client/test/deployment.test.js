import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

test('Vercel builds only the frontend from the workspace root', () => {
  assert.equal(config.framework, 'vite');
  assert.equal(config.installCommand, 'npm ci --include=dev');
  assert.equal(config.buildCommand, 'npm run build');
  assert.equal(config.devCommand, 'npm run dev --workspace client -- --port $PORT');
  assert.equal(config.outputDirectory, 'client/dist');
  assert.equal(config.services, undefined, 'the backend stays on Render, not in Vercel Services');
});

test('the Render API proxy preserves /api and page rewrites leave static data and assets alone', () => {
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: 'https://akashsathi.onrender.com/api/:path*' },
    { source: '/:page(map|route|alert)', destination: '/index.html' },
    { source: '/flood/:path*', destination: '/index.html' },
    { source: '/admin/:path*', destination: '/index.html' },
  ]);
  const apiHeaders = config.headers.find((rule) => rule.source === '/api/:path*')?.headers;
  assert.ok(apiHeaders?.some((header) => header.key === 'x-vercel-enable-rewrite-caching' && header.value === '0'));
});

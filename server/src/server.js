import mongoose from 'mongoose';
import { app } from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { startJobs, stopJobs } from './jobs/scheduler.js';
import { initAlertModels, initDataModels } from './models/index.js';

try {
  await connectDatabase();
  // The alert engine's unique indexes are guarantees (one notification per subscriber, event and rule), so they exist before the first request.
  await initAlertModels();
  await initDataModels();

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(env.port, () => resolve(listener));
    listener.once('error', reject);
  });

  console.log(`API listening on http://localhost:${env.port}/api`);
  if (env.admin.authOff) console.warn('[admin] ADMIN_AUTH=off: /admin needs no passcode from this machine. Use it for local demos only.');

  // Background collectors start after the API is up so requests are never blocked by upstream fetches.
  await startJobs();

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    setTimeout(() => process.exit(1), 10_000).unref();
    stopJobs();
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error('Unable to start the API. Check MONGODB_URI and ensure MongoDB is running.');
  console.error(error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
}

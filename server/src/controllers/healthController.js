import mongoose from 'mongoose';
import { allStatuses } from '../services/weatherStore.js';

export function getHealth(req, res) {
  const connected = mongoose.connection.readyState === 1;

  res.status(connected ? 200 : 503).json({
    status: connected ? 'ok' : 'unavailable',
    database: connected ? 'connected' : 'disconnected',
    sources: allStatuses(),
  });
}

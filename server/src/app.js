import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { env } from './config/env.js';
import { telegramWebhook } from './controllers/channelController.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { apiRoutes } from './routes/index.js';

export const app = express();

app.disable('x-powered-by');
// Behind a reverse proxy every request would otherwise share the proxy's address, and the per-address rate limits would count everyone together.
if (env.trustProxy) app.set('trust proxy', env.trustProxy);
app.use(compression());
// credentials: the subscriber and admin cookies travel with API requests (the Vite dev server proxies /api, so it is same-origin there).
app.use(cors({ origin: env.clientOrigin, credentials: true }));
// Telegram updates can exceed the 10 kB limit used elsewhere (a long message in Bangla is three bytes per letter), and an update that
// is rejected is retried by Telegram. The secret header is checked before anything is done with the body.
app.post('/api/channels/telegram/webhook', express.json({ limit: '64kb' }), telegramWebhook);
app.use(express.json({ limit: '10kb' }));
app.use('/api', apiRoutes);
app.use(notFound);
app.use(errorHandler);

import dns from 'node:dns';
import { env } from '../server/src/config/env.js';

// Preloaded in the runner and every test worker. Each database test creates and removes its own mern_test_* database.
if (env.dnsServers.length) dns.setServers(env.dnsServers);
process.env.TEST_MONGODB_URI ||= env.mongoUri;

import dns from 'node:dns';
import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDatabase() {
  // mongodb+srv:// URIs need SRV lookups, which use Node's own resolver rather than the operating system's.
  if (env.dnsServers.length) dns.setServers(env.dnsServers);

  mongoose.set('bufferCommands', false);
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log('MongoDB connected.');
}

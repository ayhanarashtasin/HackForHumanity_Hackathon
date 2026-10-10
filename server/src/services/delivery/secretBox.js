import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync,
} from 'node:crypto';
import { env } from '../../config/env.js';

// Phone numbers are the only contact detail the app stores, and only for people who chose WhatsApp or SMS. They are encrypted at rest
// (AES-256-GCM) with a key derived from CHANNEL_SECRET, and an HMAC of the number lets the app compare numbers without reading them.
// Without CHANNEL_SECRET nothing is stored: the phone channels are simply unavailable.
let cache = null;

function keys() {
  const { secret } = env.channels;
  if (!secret) throw new Error('CHANNEL_SECRET is not configured.');
  if (cache?.secret !== secret) {
    const root = scryptSync(secret, 'akashsathi-channel-secret-v1', 64);
    cache = { secret, encryption: root.subarray(0, 32), mac: root.subarray(32, 64) };
  }
  return cache;
}

export const secretBoxReady = () => Boolean(env.channels.secret);

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys().encryption, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decrypt(blob) {
  const [version, iv, tag, body] = String(blob ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised encrypted value.');
  const decipher = createDecipheriv('aes-256-gcm', keys().encryption, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export const hmac = (value) => createHmac('sha256', keys().mac).update(String(value)).digest('hex');

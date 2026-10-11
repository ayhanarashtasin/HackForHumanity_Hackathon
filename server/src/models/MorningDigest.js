import mongoose from 'mongoose';

// One row per person per Bangladesh day: the record that the morning weather message was (or is being) sent. The unique key
// (subscriber, date) is the idempotency guarantee: however often the job ticks, and however many servers share the database,
// a person gets at most one morning message a day. Only references and outcomes are kept: the text is rebuilt from the stored forecast,
// never copied, and nothing about the person beyond the reference to their profile is written here.
const morningDigestSchema = new mongoose.Schema(
  {
    subscriberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscriber', required: true },
    // YYYY-MM-DD in Asia/Dhaka.
    date: { type: String, required: true },
    // sending: claimed by a worker (leaseUntil guards a crashed one) | retry: a send failed and will be tried again | sent | skipped | failed
    status: { type: String, enum: ['sending', 'retry', 'sent', 'skipped', 'failed'], default: 'sending' },
    attempts: { type: Number, default: 0 },
    // A person with two saved areas gets two messages; a retry continues after the ones that already went out.
    sentParts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    // retry | permanent | blocked | auth | config: why it did not go out (never a credential, never a message body).
    errorClass: { type: String, default: null },
    lastError: { type: String, default: null },
    // Why it was left out on purpose: no_area, no_forecast.
    skippedReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    purgeAfter: { type: Date, required: true },
  },
  { versionKey: false, minimize: false },
);

morningDigestSchema.index({ subscriberId: 1, date: 1 }, { unique: true });
morningDigestSchema.index({ date: 1, status: 1 });
morningDigestSchema.index({ purgeAfter: 1 }, { expireAfterSeconds: 0 });

export const MorningDigest = mongoose.model('MorningDigest', morningDigestSchema);

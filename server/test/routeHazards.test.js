import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { HazardEvent } from '../src/models/HazardEvent.js';
import { routeHazards } from '../src/services/delivery/botReports/data.js';
import {
  BADDA, HOUR, NOW, SAVAR, makeEvent,
} from './support/alertFixtures.js';

// The active hazards a /route reply lists: on the road's upazilas or districts, in force during the trip, never demo events.
const testUri = process.env.TEST_MONGODB_URI;
const dbTest = (name, fn) => test(name, { skip: !testUri }, fn);

before(async () => {
  if (!testUri) return;
  await mongoose.connect(testUri, { dbName: `mern_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`, serverSelectionTimeoutMS: 5000 });
  await HazardEvent.init();
});

beforeEach(async () => {
  if (testUri) await HazardEvent.deleteMany({});
});

after(async () => {
  try {
    if (testUri && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
});

dbTest('route hazards: on the road and during the trip only; ended, withdrawn, demo and elsewhere are left out', async () => {
  const wanted = [
    makeEvent({ hazardType: 'HEAVY_RAIN', upazilas: [BADDA], from: 1, until: 5 }),
    makeEvent({ hazardType: 'STRONG_WIND', upazilas: [], districts: ['3026'], scope: 'district', from: -2, until: 3 }),
  ];
  const unwanted = [
    { ...makeEvent({ hazardType: 'HEAVY_RAIN', upazilas: [BADDA] }), lifecycle: 'withdrawn' },
    { ...makeEvent({ hazardType: 'HEAT_STRESS', upazilas: [BADDA] }), isDemo: true },
    makeEvent({ hazardType: 'HEAVY_RAIN', upazilas: [SAVAR], from: -5, until: -1 }), // over before the trip
    makeEvent({ hazardType: 'HEAVY_RAIN', upazilas: [SAVAR], from: 20, until: 24 }), // starts after arrival
    makeEvent({ hazardType: 'HEAVY_RAIN', upazilas: ['100409'], districts: ['1004'] }), // another part of the country
  ];
  const stamped = (event) => ({ ...event, firstDetectedAt: new Date(NOW), lastConfirmedAt: new Date(NOW), lastUpdatedAt: new Date(NOW) });
  await HazardEvent.insertMany([...wanted, ...unwanted].map(stamped));

  const found = await routeHazards({
    pcodes: [BADDA, SAVAR], districtCodes: ['3026'], fromMs: NOW, untilMs: NOW + 10 * HOUR,
  });
  assert.deepEqual(found.map((event) => event.hazardType).sort(), ['HEAVY_RAIN', 'STRONG_WIND']);
  assert.ok(found.every((event) => event.coverage && event.validUntil && !('evidence' in event)), 'only what the reply shows is read');
});

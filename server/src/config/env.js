import dotenv from 'dotenv';
import { SEVERITIES } from './alertConstants.js';

dotenv.config({ path: new URL('../../.env', import.meta.url), quiet: true });

function numberFromEnv(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);

  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }

  return value;
}

function severityFromEnv(name, fallback) {
  const value = (process.env[name] || fallback).trim().toUpperCase();
  if (!SEVERITIES.includes(value)) throw new Error(`${name} must be one of ${SEVERITIES.join(', ')}.`);
  return value;
}

// A comma-separated list of delivery channels ("telegram,whatsapp"); an unknown name stops start-up.
function channelsFromEnv(name, fallback) {
  const raw = process.env[name] === undefined ? fallback : process.env[name];
  const list = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unknown = list.filter((item) => !['telegram', 'whatsapp', 'sms'].includes(item));
  if (unknown.length) throw new Error(`${name} may only list telegram, whatsapp and sms.`);
  return list;
}

function timeFromEnv(name, fallback) {
  const value = (process.env[name] || fallback).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name} must be a time like 06:00 (24 hours, Bangladesh time).`);
  return value;
}

// A JSON object of string headers (for example an API key). A malformed value is ignored rather than crashing start-up.
function jsonFromEnv(name) {
  try {
    const parsed = JSON.parse(process.env[name] || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])) : {};
  } catch {
    return {};
  }
}

// The .env.example placeholders must not count as real credentials.
function credentialFromEnv(name, placeholder) {
  const value = (process.env[name] || '').trim();
  return value === placeholder ? '' : value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: numberFromEnv('PORT', 5000, { min: 1, max: 65535, integer: true }),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/environmental_hackathon',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  // Number of reverse proxies in front of the API (1 for most hosts); leave unset when the API is reached directly.
  trustProxy: numberFromEnv('TRUST_PROXY', 0, { min: 0, max: 10, integer: true }),
  // Optional, comma-separated. Needed when Node's resolver cannot reach a DNS server (mongodb+srv:// lookups fail with querySrv ECONNREFUSED).
  dnsServers: (process.env.DNS_SERVERS || '').split(',').map((server) => server.trim()).filter(Boolean),

  weather: {
    // Set WEATHER_JOBS=off to run the API without background data collection.
    jobsEnabled: process.env.WEATHER_JOBS !== 'off',
    bmdApiUrl: (process.env.BMD_API_URL || 'https://api.bdservers.site').replace(/\/$/, ''),
    bmdRadarUrl: (process.env.BMD_RADAR_URL || 'https://radar.bmd.gov.bd').replace(/\/$/, ''),
    openMeteoUrl: process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast',
    gibsUrl: (process.env.GIBS_URL || 'https://gibs.earthdata.nasa.gov').replace(/\/$/, ''),
    bmdCheckMinutes: numberFromEnv('BMD_CHECK_MINUTES', 30, { min: 5, integer: true }),
    openMeteoMinutes: numberFromEnv('OPEN_METEO_MINUTES', 180, { min: 30, integer: true }),
    radarMinutes: numberFromEnv('RADAR_MINUTES', 10, { min: 2, integer: true }),
    satelliteMinutes: numberFromEnv('SATELLITE_MINUTES', 30, { min: 5, integer: true }),
    // How often the storm job looks for a newly published frame (a check for a frame that is not there yet costs about 1 KB).
    stormMinutes: numberFromEnv('STORM_MINUTES', 2, { min: 1, integer: true }),
    // A source with no successful refresh for this long is reported as STALE.
    staleAfterHours: numberFromEnv('FORECAST_STALE_HOURS', 36, { min: 1 }),
    // Days of per-district run summaries kept in MongoDB for trends and back-testing (0 turns the history off).
    historyDays: numberFromEnv('WEATHER_HISTORY_DAYS', 60, { min: 0, max: 365, integer: true }),
  },

  // The Telegram /route place search. A name the bot's own lists do not know (a village, a bazar, a landmark) is looked up with
  // OpenStreetMap's Nominatim, limited to Bangladesh: the typed name is sent to that service. ROUTE_GEOCODER=off keeps every search local.
  routing: {
    geocoder: (process.env.ROUTE_GEOCODER || 'osm').trim().toLowerCase() === 'off' ? 'off' : 'osm',
    geocoderUrl: (process.env.ROUTE_GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    // Nominatim's usage policy asks for a contact address on heavier use; it is sent as the `email` parameter when set.
    geocoderEmail: (process.env.ROUTE_GEOCODER_EMAIL || '').trim(),
  },

  // Credentials stay server-side. Never log or return these values.
  xweather: {
    clientId: credentialFromEnv('XWEATHER_CLIENT_ID', 'your_client_id'),
    clientSecret: credentialFromEnv('XWEATHER_CLIENT_SECRET', 'your_client_secret'),
    baseUrl: (process.env.XWEATHER_BASE_URL || 'https://data.api.xweather.com').replace(/\/$/, ''),
    // Historical observation of the free allowance; updated from response headers at runtime.
    budgetRemaining: numberFromEnv('XWEATHER_BUDGET_REMAINING', 14817, { min: 0 }),
    budgetReserve: numberFromEnv('XWEATHER_BUDGET_RESERVE', 100, { min: 0 }),
    // The allowance resets on this date (observed from the response headers); it then repeats every `periodDays`.
    periodReset: process.env.XWEATHER_PERIOD_RESET || '2026-11-09T00:00:00Z',
    periodDays: numberFromEnv('XWEATHER_PERIOD_DAYS', 30, { min: 1, integer: true }),
    requestsPerMinute: numberFromEnv('XWEATHER_REQUESTS_PER_MINUTE', 60, { min: 1, integer: true }),
    // Used until a response reports its real X-Cost-Tokens.
    assumedCostPerRequest: numberFromEnv('XWEATHER_ASSUMED_COST', 1, { min: 1 }),
  },

  // FloodSense: FFWC river gauges and the DDM flood-shelter list. Both are public government services; the FFWC API needs a key header
  // and an Origin/Referer that its gateway accepts. FFWC_ENABLED=off stops every request; without FFWC_API_KEY the flood stage stays quiet.
  flood: {
    enabled: process.env.FFWC_ENABLED !== 'off',
    apiUrl: (process.env.FFWC_API_URL || 'https://api.ffwc.gov.bd').replace(/\/$/, ''),
    apiKey: credentialFromEnv('FFWC_API_KEY', 'your_ffwc_api_key'),
    origin: (process.env.FFWC_ORIGIN || 'https://ffwc.gov.bd').replace(/\/$/, ''),
    timeoutMs: numberFromEnv('FFWC_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000, integer: true }),
    refreshMinutes: numberFromEnv('FFWC_REFRESH_MINUTES', 30, { min: 5, max: 360, integer: true }),
    // A reading older than this can annotate an existing alert but cannot create or escalate one.
    maxAgeMinutes: numberFromEnv('FFWC_MAX_AGE_MINUTES', 180, { min: 10, max: 1_440, integer: true }),
    sheltersEnabled: process.env.DDM_SHELTERS !== 'off',
    shelterUrl: process.env.DDM_SHELTER_URL || 'https://rapid.ddm.gov.bd/service/shelter_info',
    shelterRefreshHours: numberFromEnv('DDM_SHELTER_REFRESH_HOURS', 24, { min: 1, max: 168, integer: true }),
    maxShelters: numberFromEnv('FLOOD_MAX_SHELTERS', 3, { min: 1, max: 5, integer: true }),
  },

  lightning: {
    enabled: process.env.LIGHTNING_ENABLED !== 'off',
    // YYYY-MM-DD in Asia/Dhaka. Empty = the campaign starts the first day the job runs with credentials.
    campaignStart: process.env.LIGHTNING_CAMPAIGN_START || '',
    campaignDays: numberFromEnv('LIGHTNING_CAMPAIGN_DAYS', 10, { min: 1, max: 10, integer: true }),
    maxSlots: numberFromEnv('LIGHTNING_MAX_SLOTS', 30, { min: 1, max: 30, integer: true }),
    graceMinutes: numberFromEnv('LIGHTNING_GRACE_MINUTES', 60, { min: 0, integer: true }),
  },

  // The alert engine (ALERT_ENGINE_PLAN.md). Thresholds are NOT environment variables: they live in config/alertRules.js, versioned.
  alerts: {
    engineEnabled: process.env.ALERT_ENGINE !== 'off',
    tickMinutes: numberFromEnv('ALERT_TICK_MINUTES', 2, { min: 1, max: 60, integer: true }),
    maxSubscribers: numberFromEnv('ALERT_MAX_SUBSCRIBERS', 5000, { min: 1, integer: true }),
    maxForecastAreas: numberFromEnv('ALERT_MAX_FORECAST_AREAS', 10, { min: 0, integer: true }),
    maxMarinePoints: numberFromEnv('ALERT_MAX_MARINE_POINTS', 4, { min: 0, integer: true }),
    // Alert-engine use of the Xweather allowance (forecast, maritime, lightning). Needs credentials as well.
    xweatherEnabled: process.env.ALERT_XWEATHER !== 'off',
    // Reads BMD's public bulletin pages (no credentials, no quota); off for offline runs.
    bulletinsEnabled: process.env.ALERT_BULLETINS !== 'off',
    lightningBaseline: process.env.ALERT_LIGHTNING_BASELINE !== 'off',
    activityTtlHours: numberFromEnv('ALERT_ACTIVITY_TTL_HOURS', 12, { min: 1, max: 72, integer: true }),
    dailyAdvisoryCap: numberFromEnv('ALERT_DAILY_ADVISORY_CAP', 3, { min: 1, integer: true }),
    // BMD rainfall amounts are only trusted as a second opinion once their unit is confirmed (spike S3).
    bmdRainVerified: process.env.ALERT_BMD_RAIN_VERIFIED === 'on',
    // Rain forecast confidence from ml-service/ (one extra line on rain alerts). Not set: the local service `npm run dev` starts, outside
    // production; set but empty: off. Alerts are unchanged without it.
    mlServiceUrl: (process.env.ML_SERVICE_URL ?? ((process.env.NODE_ENV || 'development') === 'production' ? '' : 'http://127.0.0.1:8001')).trim().replace(/\/$/, ''),
    mlTimeoutMs: numberFromEnv('ML_TIMEOUT_MS', 3000, { min: 200, max: 30_000, integer: true }),
  },

  // External delivery: Telegram, WhatsApp and SMS read stored notifications and send a short copy. Each channel stays off until its
  // credentials are set; the in-app inbox always works. Credentials stay server-side and are never logged or returned.
  channels: {
    deliveryEnabled: process.env.DELIVERY !== 'off',
    // Encrypts and hashes the phone numbers people verify. Without it the phone channels (WhatsApp, SMS) are unavailable.
    secret: ((value) => (value.length >= 16 && !/^change_me/i.test(value) ? value : ''))((process.env.CHANNEL_SECRET || '').trim()),
    // The public address of the site, used for the "details" link inside messages.
    publicUrl: (process.env.PUBLIC_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/$/, ''),
    tickSeconds: numberFromEnv('DELIVERY_TICK_SECONDS', 30, { min: 5, max: 600, integer: true }),
    maxAttempts: numberFromEnv('DELIVERY_MAX_ATTEMPTS', 4, { min: 1, max: 10, integer: true }),
    // An alert whose latest change is older than this is not sent to a channel (it is still in the inbox).
    maxAgeMinutes: numberFromEnv('DELIVERY_MAX_AGE_MINUTES', 180, { min: 5, integer: true }),
    // Messages per person per channel per Bangladesh day. CRITICAL alerts are never held back by the cap.
    dailyCap: {
      telegram: numberFromEnv('DELIVERY_DAILY_CAP_TELEGRAM', 20, { min: 1, integer: true }),
      whatsapp: numberFromEnv('DELIVERY_DAILY_CAP_WHATSAPP', 6, { min: 1, integer: true }),
      sms: numberFromEnv('DELIVERY_DAILY_CAP_SMS', 6, { min: 1, integer: true }),
    },
    // Lowest severity sent on a channel. SMS and WhatsApp can cost money per message, so they start at WARNING.
    minSeverity: {
      telegram: severityFromEnv('DELIVERY_MIN_SEVERITY_TELEGRAM', 'ADVISORY'),
      whatsapp: severityFromEnv('DELIVERY_MIN_SEVERITY_WHATSAPP', 'WARNING'),
      sms: severityFromEnv('DELIVERY_MIN_SEVERITY_SMS', 'WARNING'),
    },
    // Channels that carry satellite storm-approach warnings (STORM_APPROACH). Telegram only for now: WhatsApp and SMS cost money per
    // message, and a stormy afternoon can warn the same person more than once (they are still in the inbox).
    stormChannels: channelsFromEnv('STORM_ALERT_CHANNELS', 'telegram'),

    // The morning weather message to every Telegram chat connected to a profile with a saved area (MORNING_DIGEST=off turns it off).
    // Bangladesh time. A server that was down at the set time can still send it for `graceHours` afterwards; later than that it skips the day.
    morningDigest: {
      enabled: process.env.MORNING_DIGEST !== 'off',
      time: timeFromEnv('MORNING_DIGEST_TIME', '06:00'),
      graceHours: numberFromEnv('MORNING_DIGEST_GRACE_HOURS', 4, { min: 0, max: 12, integer: true }),
    },

    telegram: {
      token: credentialFromEnv('TELEGRAM_BOT_TOKEN', 'your_bot_token'),
      apiUrl: (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, ''),
      // Set a public https URL to receive updates by webhook; leave empty to poll (fine for local development).
      webhookUrl: (process.env.TELEGRAM_WEBHOOK_URL || '').trim(),
      // Telegram only allows A-Z a-z 0-9 _ - here; anything else disables the webhook rather than failing later.
      webhookSecret: ((value) => (/^[A-Za-z0-9_-]{16,256}$/.test(value) && !/^change_me/i.test(value) ? value : ''))((process.env.TELEGRAM_WEBHOOK_SECRET || '').trim()),
      // Weather commands (/update, /heat ...) one chat may send in ten minutes; beyond it the bot asks the person to wait.
      commandLimit: numberFromEnv('TELEGRAM_COMMAND_LIMIT', 30, { min: 1, max: 500, integer: true }),
    },

    whatsapp: {
      token: credentialFromEnv('WHATSAPP_ACCESS_TOKEN', 'your_access_token'),
      phoneNumberId: credentialFromEnv('WHATSAPP_PHONE_NUMBER_ID', 'your_phone_number_id'),
      apiUrl: (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
      // Business-initiated WhatsApp messages must use approved templates (see README: "WhatsApp templates").
      alertTemplate: process.env.WHATSAPP_ALERT_TEMPLATE || 'akashsathi_alert',
      otpTemplate: (process.env.WHATSAPP_OTP_TEMPLATE || '').trim(),
      languages: { en: process.env.WHATSAPP_TEMPLATE_LANG_EN || 'en', bn: process.env.WHATSAPP_TEMPLATE_LANG_BN || 'bn' },
    },

    sms: {
      provider: ((value) => (['twilio', 'http'].includes(value) ? value : ''))((process.env.SMS_PROVIDER || '').trim().toLowerCase()),
      twilio: {
        accountSid: credentialFromEnv('TWILIO_ACCOUNT_SID', 'your_account_sid'),
        authToken: credentialFromEnv('TWILIO_AUTH_TOKEN', 'your_auth_token'),
        from: (process.env.TWILIO_FROM || '').trim(),
        messagingServiceSid: (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim(),
        apiUrl: (process.env.TWILIO_API_URL || 'https://api.twilio.com').replace(/\/$/, ''),
      },
      // A generic HTTP gateway (most Bangladeshi bulk-SMS providers): see README "SMS gateways" for the placeholders.
      http: {
        url: (process.env.SMS_HTTP_URL || '').trim(),
        method: (process.env.SMS_HTTP_METHOD || 'POST').trim().toUpperCase() === 'GET' ? 'GET' : 'POST',
        contentType: (process.env.SMS_HTTP_CONTENT_TYPE || 'application/json').trim(),
        body: process.env.SMS_HTTP_BODY || '',
        headers: jsonFromEnv('SMS_HTTP_HEADERS'),
        successMatch: (process.env.SMS_HTTP_SUCCESS_MATCH || '').trim(),
      },
    },
  },

  // One shared passcode (prototype). Empty, a placeholder or fewer than 8 characters keeps /admin disabled.
  admin: {
    passcode: ((value) => (value.length >= 8 && value !== 'change_me_before_use' ? value : ''))((process.env.ADMIN_PASSCODE || '').trim()),
    // Skips the login for local demos; only honoured outside production and for loopback requests (see middleware/admin.js).
    authOff: process.env.ADMIN_AUTH === 'off' && (process.env.NODE_ENV || 'development') !== 'production',
    sessionHours: numberFromEnv('ADMIN_SESSION_HOURS', 8, { min: 1, max: 72, integer: true }),
  },
};

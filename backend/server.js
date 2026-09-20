const express = require('express');
const cors = require('cors');
const Busboy = require('busboy');
const crypto = require('crypto');
const mongoose = require('mongoose');
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.CLIENT_URL || 'https://photocall-frontend.vercel.app';
const ALLOWED_ORIGINS = new Set([FRONTEND_URL, process.env.CORS_ORIGIN, 'https://photocall-frontend.vercel.app'].filter(Boolean).map(v => String(v).replace(/\/$/, '')));
const VERCEL_FRONTEND_ORIGIN = /^https:\/\/[a-z0-9-]+(?:-[a-z0-9-]+)*\.vercel\.app$/i;
const app = express();

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = String(origin).replace(/\/$/, '');
    if (ALLOWED_ORIGINS.has(normalized) || VERCEL_FRONTEND_ORIGIN.test(normalized)) return callback(null, true);
    return callback(new Error('Origin not allowed by PhotoCall backend CORS policy.'));
  },
  credentials: false,
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','X-Guest-Id'],
  maxAge: 86400
}));
app.use(express.json({ limit: '2mb' }));

let mongoPromise = null;
const Guest = mongoose.models.PhotoCallGuest || mongoose.model('PhotoCallGuest', new mongoose.Schema({
  guestId: { type: String, unique: true, index: true },
  voiceId: String,
  voiceReady: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'photocall_guests' }));

const SignalEvent = mongoose.models.PhotoCallSignalEvent || mongoose.model('PhotoCallSignalEvent', new mongoose.Schema({
  room: { type: String, index: true },
  sender: { type: String, index: true },
  type: String,
  payload: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now, expires: 3600 }
}, { collection: 'photocall_signal_events' }));

async function connectMongo() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not configured.');
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!mongoPromise) mongoPromise = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 7000, maxPoolSize: 5 }).catch(e => { mongoPromise = null; throw e; });
  return mongoPromise;
}

function cleanGuestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,100}$/.test(id) ? id : crypto.randomUUID();
}
function cleanRoom(value) { return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80); }
function guestFrom(req) { return cleanGuestId(req.headers['x-guest-id'] || req.body?.guestId); }

async function getIceServers() {
  const fallback = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const domain = String(process.env.METERED_DOMAIN || '').replace(/\/$/, '');
  const key = String(process.env.METERED_TURN_API_KEY || '').trim();
  if (domain && key) {
    try {
      const r = await fetch(`${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data) && data.length) return data;
      }
    } catch (e) { console.warn('Metered TURN lookup failed:', e.message); }
  }
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    fallback.push({ urls: String(process.env.TURN_URL).split(',').map(v => v.trim()), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return fallback;
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'PhotoCall Backend', mode: 'production-rest-signaling', health: '/health', config: '/api/config' }));
app.get('/health', async (_req, res) => {
  let database = 'unavailable';
  if (process.env.MONGODB_URI) {
    try { await connectMongo(); database = 'connected'; } catch (e) { database = 'error'; }
  }
  res.json({ ok: true, service: 'photocall', database, turn: Boolean(process.env.METERED_DOMAIN && process.env.METERED_TURN_API_KEY), elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY), signaling: database === 'connected' ? 'rest-polling' : 'unavailable-until-database-connects' });
});
app.get('/api/config', async (_req, res) => res.json({ appName: 'PhotoCall', iceServers: await getIceServers(), signaling: 'rest-polling', maxPeersPerRoom: 2, frontend: FRONTEND_URL }));

app.post('/api/session/guest', async (req, res) => {
  try {
    await connectMongo();
    const guestId = cleanGuestId(req.body?.guestId);
    await Guest.findOneAndUpdate({ guestId }, { guestId, updatedAt: new Date() }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ guest: true, guestId, user: { id: guestId, name: 'PhotoCall Guest' } });
  } catch (e) { res.status(503).json({ message: `Database unavailable: ${e.message}` }); }
});

app.post('/api/rooms/join', async (req, res) => {
  try {
    await connectMongo();
    const room = cleanRoom(req.body?.room), guestId = guestFrom(req);
    if (!room) return res.status(400).json({ message: 'Room code is required.' });
    const recent = await SignalEvent.find({ room, type: 'join', createdAt: { $gt: new Date(Date.now() - 10 * 60 * 1000) } }).lean();
    const active = new Set(recent.map(x => x.sender));
    if (!active.has(guestId) && active.size >= 2) return res.status(409).json({ message: 'Room is full.' });
    await SignalEvent.create({ room, sender: guestId, type: 'join', payload: {} });
    res.json({ ok: true, room, peerCount: Math.min(2, active.size + (active.has(guestId) ? 0 : 1)) });
  } catch (e) { res.status(503).json({ message: `Signaling unavailable: ${e.message}` }); }
});

app.get('/api/rooms/:room/events', async (req, res) => {
  try {
    await connectMongo();
    const room = cleanRoom(req.params.room), guestId = guestFrom(req);
    const after = String(req.query.after || '000000000000000000000000');
    const cursor = /^[0-9a-fA-F]{24}$/.test(after) ? new mongoose.Types.ObjectId(after) : new mongoose.Types.ObjectId('000000000000000000000000');
    const docs = await SignalEvent.find({ room, sender: { $ne: guestId }, _id: { $gt: cursor } }).sort({ _id: 1 }).limit(50).lean();
    res.json({ events: docs.map(d => ({ id: String(d._id), type: d.type, payload: d.payload })) });
  } catch (e) { res.status(503).json({ message: `Signaling unavailable: ${e.message}` }); }
});

app.post('/api/rooms/:room/events', async (req, res) => {
  try {
    await connectMongo();
    const room = cleanRoom(req.params.room), guestId = guestFrom(req), type = String(req.body?.type || '');
    const allowed = new Set(['offer','answer','ice-candidate','call-ended','leave']);
    if (!room || !allowed.has(type)) return res.status(400).json({ message: 'Invalid signaling event.' });
    const doc = await SignalEvent.create({ room, sender: guestId, type, payload: req.body?.payload || {} });
    res.json({ ok: true, id: String(doc._id) });
  } catch (e) { res.status(503).json({ message: `Signaling unavailable: ${e.message}` }); }
});

function parseSingleAudio(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 12 * 1024 * 1024 } });
    let buffer = Buffer.alloc(0), filename = 'voice.webm', mimeType = 'audio/webm', tooLarge = false;
    bb.on('file', (_field, file, info) => { filename = info.filename || filename; mimeType = info.mimeType || mimeType; file.on('data', c => { buffer = Buffer.concat([buffer, c]); }); file.on('limit', () => { tooLarge = true; }); });
    bb.on('error', reject); bb.on('finish', () => tooLarge ? reject(new Error('Voice sample is too large (12MB maximum).')) : resolve({ buffer, filename, mimeType })); req.pipe(bb);
  });
}

app.post('/api/voice/clone', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ message: 'ELEVENLABS_API_KEY is not configured.' });
  try {
    await connectMongo(); const guestId = guestFrom(req); const sample = await parseSingleAudio(req);
    if (!sample.buffer.length || !/^audio\//.test(sample.mimeType)) return res.status(400).json({ message: 'Upload an audio recording.' });
    const form = new FormData(); form.append('name', `PhotoCall-${guestId}`); form.append('description', 'User-authorized PhotoCall voice profile'); form.append('remove_background_noise', 'true'); form.append('files[]', new Blob([sample.buffer], { type: sample.mimeType }), sample.filename);
    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.voice_id) throw new Error(data.detail?.message || data.message || `Voice provider returned ${r.status}`);
    await Guest.findOneAndUpdate({ guestId }, { voiceId: data.voice_id, voiceReady: !data.requires_verification, updatedAt: new Date() }, { upsert: true });
    res.json({ ok: true, voiceId: data.voice_id, ready: !data.requires_verification, requiresVerification: !!data.requires_verification });
  } catch (e) { res.status(502).json({ message: `Voice cloning failed: ${e.message}` }); }
});

app.post('/api/voice/convert', async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ message: 'ELEVENLABS_API_KEY is not configured.' });
  try {
    await connectMongo(); const guestId = guestFrom(req); const profile = await Guest.findOne({ guestId }).lean();
    if (!profile?.voiceId || !profile.voiceReady) return res.status(409).json({ message: 'Uploaded voice is not ready.' });
    const sample = await parseSingleAudio(req); const form = new FormData(); form.append('audio', new Blob([sample.buffer], { type: sample.mimeType }), sample.filename); form.append('model_id', process.env.ELEVENLABS_STS_MODEL || 'eleven_multilingual_sts_v2');
    const r = await fetch(`https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(profile.voiceId)}?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, body: form });
    if (!r.ok) throw new Error((await r.text()).slice(0, 500));
    res.setHeader('Content-Type', 'audio/mpeg'); res.setHeader('Cache-Control', 'no-store'); res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).json({ message: `Voice conversion failed: ${e.message}` }); }
});

app.use((error, _req, res, _next) => { console.error('PhotoCall server error:', error); if (!res.headersSent) res.status(500).json({ message: error.message || 'Internal server error.' }); });

if (require.main === module) app.listen(PORT, () => console.log(`PhotoCall backend listening on ${PORT}`));
module.exports = app;

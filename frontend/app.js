const $ = (s) => document.querySelector(s);

const candidates = [
  import.meta.env.VITE_API_URL,
  import.meta.env.VITE_PRODUCTION_API_URL,
  'https://photocall-backend.vercel.app'
].filter(Boolean).map(v => String(v).replace(/\/$/, ''));

let API = candidates[0] || '';
let guestId = localStorage.getItem('photocall_guest_id') || crypto.randomUUID();
localStorage.setItem('photocall_guest_id', guestId);
let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
let pollTimer = null, lastEventId = '000000000000000000000000';
let roomJoined = false;
let photos = [], selected = 0, img = null, mirrored = false;
let faceBox = null, faceLandmarks = null, faceBase = null, faceTriangles = null, faceState = null, avatarReady = false, sourceCanvas = document.createElement('canvas'), sourceCtx = sourceCanvas.getContext('2d');
let audioCtx, source, filter, compressor, shaper, analyser, destination, micStream, processedStream;
let voiceRecorder = null, voiceCloneQueueTime = 0, uploadedVoiceReady = false;
let pc = null, muted = false, voiceMode = 'normal', audioLevel = 0, timerStart = 0, timerHandle = null, outgoingStream = null;
let animationFrame = 0, avatarTime = 0;

const avatarEnabledEl = $('#avatarEnabled');
const voiceEnabledEl = $('#voiceEnabled');
const voiceFileEl = $('#voiceFile');
const voiceStatusEl = $('#voiceStatus');
const canvas = $('#avatar');
const ctx = canvas.getContext('2d');
const files = $('#photos');
const gallery = $('#gallery');
const remote = $('#remote');
const hint = $('#hint');
const talking = $('#talking');
const meterBar = $('#meterBar');
const photoValidation = $('#photoValidation');

function say(text) { $('#msg').textContent = text; }
function status(text, online = false) {
  $('#status').textContent = text;
  $('#status').className = `status ${online ? 'online' : 'offline'}`;
}
function headers(extra = {}) { return { 'Content-Type': 'application/json', ...extra }; }

async function fetchTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }); }
  finally { clearTimeout(timer); }
}

async function discoverBackend() {
  let last;
  for (const base of [...new Set(candidates)]) {
    for (const path of ['/health', '/']) {
      try {
        const r = await fetchTimeout(`${base}${path}`);
        if (r.ok) { API = base; return; }
        last = new Error(`${base}${path} returned ${r.status}`);
      } catch (e) { last = e; }
    }
  }
  throw new Error(`PhotoCall backend is unreachable. ${last?.message || 'Check the Vercel backend deployment and VITE_API_URL.'}`);
}

async function api(path, options = {}) {
  const r = await fetchTimeout(API + path, options, 20000);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `Request failed (${r.status})`);
  return d;
}

async function startGuestSession() {
  const d = await api('/api/session/guest', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ guestId })
  });
  guestId = d.guestId || guestId;
  localStorage.setItem('photocall_guest_id', guestId);
  $('#userBadge').textContent = 'Guest';
}

async function loadConfig() {
  const d = await api('/api/config');
  if (Array.isArray(d.iceServers) && d.iceServers.length) iceServers = d.iceServers;
}

async function sendSignal(type, payload = {}) {
  if (!roomJoined) return;
  return api(`/api/rooms/${encodeURIComponent($('#room').value.trim())}/events`, {
    method: 'POST',
    headers: headers({ 'X-Guest-Id': guestId }),
    body: JSON.stringify({ type, payload })
  });
}

async function joinRoom() {
  const room = $('#room').value.trim();
  if (!room) throw new Error('Enter a room code.');
  const d = await api('/api/rooms/join', {
    method: 'POST',
    headers: headers({ 'X-Guest-Id': guestId }),
    body: JSON.stringify({ room, guestId })
  });
  roomJoined = true;
  lastEventId = '000000000000000000000000';
  $('#remoteState').textContent = d.peerCount > 1 ? 'Partner found — negotiating…' : 'Waiting for partner…';
  startPolling();
}

async function pollEvents() {
  if (!roomJoined) return;
  try {
    const room = encodeURIComponent($('#room').value.trim());
    const d = await api(`/api/rooms/${room}/events?after=${encodeURIComponent(lastEventId)}`, {
      headers: { 'X-Guest-Id': guestId }
    });
    for (const e of d.events || []) { lastEventId = e.id; await handleEvent(e); }
  } catch (e) { console.warn('Signaling poll:', e.message); }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollEvents, 700);
  pollEvents();
  status('Signaling online', true);
}

async function handleEvent(e) {
  if (e.type === 'join') {
    $('#remoteState').textContent = 'Partner found — connecting…';
    if (pc && pc.signalingState === 'stable' && !pc.remoteDescription) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal('offer', { offer: pc.localDescription });
    }
    return;
  }
  if (e.type === 'offer') {
    if (!pc) makePeer();
    await pc.setRemoteDescription(e.payload.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal('answer', { answer: pc.localDescription });
    return;
  }
  if (e.type === 'answer') { if (pc) await pc.setRemoteDescription(e.payload.answer); return; }
  if (e.type === 'ice-candidate') { if (pc && e.payload?.candidate) await pc.addIceCandidate(e.payload.candidate).catch(() => {}); return; }
  if (e.type === 'call-ended' || e.type === 'leave') { say('Your partner ended the call.'); cleanup(false); }
}

async function boot() {
  try {
    status('Connecting…');
    await discoverBackend();
    await startGuestSession();
    await loadConfig();
    status('Ready', true);
    say('PhotoCall is ready. Upload a clear human photo to create your live avatar.');
  } catch (e) {
    console.error(e);
    status('Backend offline');
    say(e.message || 'PhotoCall backend is unavailable.');
  }
}

function galleryRender() {
  gallery.innerHTML = '';
  photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = `thumb ${i === selected ? 'active' : ''}`;
    const im = document.createElement('img');
    im.src = p.url;
    im.alt = `Avatar ${i + 1}`;
    b.append(im);
    b.onclick = () => { selected = i; mirrored = false; loadPhoto(); galleryRender(); };
    gallery.append(b);
  });
}

async function loadFaceLandmarker() {
  if (window._photoCallFaceLandmarker) return window._photoCallFaceLandmarker;
  if (!window._photoCallVisionPromise) {
    window._photoCallVisionPromise = import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm');
  }
  const { FaceLandmarker, FilesetResolver } = await window._photoCallVisionPromise;
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
  window._photoCallFaceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU'
    },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true
  });
  return window._photoCallFaceLandmarker;
}

function imageToCanvasPoint(lm, image = img) {
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / image.width, ch / image.height);
  const w = image.width * scale, h = image.height * scale;
  return { x: (lm.x * image.width - image.width / 2) * scale + cw / 2, y: (lm.y * image.height - image.height / 2) * scale + ch / 2 };
}

function buildFaceTriangles(points) {
  // Bowyer-Watson Delaunay triangulation. We use the detected face points only,
  // which produces a dense mesh for photo deformation without a native dependency.
  const pts = points.map((p, i) => ({ x: p.x, y: p.y, i }));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const dx = maxX - minX || 1, dy = maxY - minY || 1, delta = Math.max(dx, dy) * 20;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const superPts = [
    { x: cx - 2 * delta, y: cy - delta, i: -1 },
    { x: cx, y: cy + 2 * delta, i: -2 },
    { x: cx + 2 * delta, y: cy - delta, i: -3 }
  ];
  const all = pts.concat(superPts);
  const superA = pts.length, superB = pts.length + 1, superC = pts.length + 2;
  let triangles = [[superA, superB, superC]];
  const circum = (a, b, c) => {
    const A = b.x - a.x, B = b.y - a.y, C = c.x - a.x, D = c.y - a.y;
    const E = A * (a.x + b.x) + B * (a.y + b.y);
    const F = C * (a.x + c.x) + D * (a.y + c.y);
    const G = 2 * (A * (c.y - b.y) - B * (c.x - b.x));
    if (Math.abs(G) < 1e-8) return { x: 0, y: 0, r2: Infinity };
    const x = (D * E - B * F) / G, y = (A * F - C * E) / G;
    return { x, y, r2: (x - a.x) ** 2 + (y - a.y) ** 2 };
  };
  const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  for (let pi = 0; pi < pts.length; pi++) {
    const p = all[pi], bad = [];
    for (let ti = 0; ti < triangles.length; ti++) {
      const [a, b, c] = triangles[ti], cc = circum(all[a], all[b], all[c]);
      if ((p.x - cc.x) ** 2 + (p.y - cc.y) ** 2 <= cc.r2 + 0.01) bad.push(ti);
    }
    const edges = new Map();
    for (let k = bad.length - 1; k >= 0; k--) {
      const tri = triangles[bad[k]];
      triangles.splice(bad[k], 1);
      [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]].forEach(([a, b]) => {
        const key = edgeKey(a, b);
        const old = edges.get(key);
        if (old) old.count++;
        else edges.set(key, { a, b, count: 1 });
      });
    }
    for (const e of edges.values()) if (e.count === 1) triangles.push([e.a, e.b, pi]);
  }
  return triangles.filter(([a,b,c]) => a < pts.length && b < pts.length && c < pts.length);
}

function calculateFaceState(landmarks) {
  const get = i => landmarks[i] || { x: 0.5, y: 0.5 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mouth = dist(get(13), get(14));
  const mouthWidth = Math.max(0.001, dist(get(61), get(291)));
  const leftEye = dist(get(159), get(145));
  const rightEye = dist(get(386), get(374));
  const leftEyeWidth = Math.max(0.001, dist(get(33), get(133)));
  const rightEyeWidth = Math.max(0.001, dist(get(362), get(263)));
  return { mouthRatio: mouth / mouthWidth, eyeL: leftEye / leftEyeWidth, eyeR: rightEye / rightEyeWidth };
}

async function validateHumanPhoto(image) {
  photoValidation.textContent = 'Photo check: detecting face + landmarks…';
  faceBox = null; faceLandmarks = null; faceTriangles = null; faceBase = null; faceState = null;
  try {
    const landmarker = await loadFaceLandmarker();
    const result = landmarker.detect(image);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length < 400) throw new Error('No complete human face landmark mesh detected.');
    faceLandmarks = landmarks;
    faceBase = landmarks.map(p => imageToCanvasPoint(p, image));
    const meshIndices = [];
    for (let i = 0; i < faceBase.length; i++) {
      if (i % 4 === 0 || [10,13,14,33,61,70,78,95,105,133,145,152,159,234,263,291,300,308,334,362,374,386,454].includes(i)) meshIndices.push(i);
    }
    const reduced = meshIndices.map(i => faceBase[i]);
    const localTriangles = buildFaceTriangles(reduced);
    faceTriangles = localTriangles.map(([a,b,c]) => [meshIndices[a], meshIndices[b], meshIndices[c]]);
    sourceCanvas.width = canvas.width; sourceCanvas.height = canvas.height;
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    drawCoverOnContext(sourceCtx, image, mirrored, 0, 0, 1);
    faceBase = faceBase.map((pt) => mirrored ? { x: canvas.width - pt.x, y: pt.y } : pt);
    faceState = calculateFaceState(landmarks);
    const xs = faceBase.map(p => p.x), ys = faceBase.map(p => p.y);
    faceBox = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    photoValidation.textContent = `Human face detected: ${landmarks.length} landmarks. Avatar deformation engine ready.`;
    avatarReady = true;
    return true;
  } catch (e) {
    console.error('Face landmark engine:', e);
    avatarReady = false;
    photoValidation.textContent = `Face animation could not initialize: ${e.message}`;
    return false;
  }
}

function loadPhoto() {
  if (!photos.length) {
    img = null; faceBox = null; faceLandmarks = null; faceTriangles = null; faceBase = null; avatarReady = false;
    hint.classList.remove('hidden'); $('#photoInfo').textContent = 'No photo selected';
    photoValidation.textContent = 'Photo check: waiting for an image.'; return;
  }
  hint.classList.add('hidden'); $('#photoInfo').textContent = `${selected + 1} / ${photos.length} selected`;
  img = new Image(); img.onload = async () => { await validateHumanPhoto(img); drawAvatar(); }; img.src = photos[selected].url;
}

files.onchange = e => {
  const picked = [...e.target.files].filter(f => /^image\/(jpeg|png|webp)$/.test(f.type));
  picked.forEach(file => photos.push({ url: URL.createObjectURL(file), name: file.name, file }));
  if (picked.length) { selected = photos.length - 1; galleryRender(); loadPhoto(); say(`${picked.length} photo${picked.length === 1 ? '' : 's'} ready. PhotoCall is building the facial landmark mesh now.`); }
};

$('#flip').onclick = () => { mirrored = !mirrored; if (img) loadPhoto(); else drawAvatar(); };
$('#reset').onclick = () => { photos.forEach(p => URL.revokeObjectURL(p.url)); photos = []; selected = 0; loadPhoto(); galleryRender(); say('Avatar reset.'); };

function drawCoverOnContext(targetCtx, image, mirror = mirrored, swayX = 0, swayY = 0, scaleBoost = 1) {
  const cw = canvas.width, ch = canvas.height, scale = Math.max(cw / image.width, ch / image.height) * scaleBoost;
  const w = image.width * scale, h = image.height * scale;
  targetCtx.save(); targetCtx.translate(cw / 2 + swayX, ch / 2 + swayY); targetCtx.scale(mirror ? -1 : 1, 1); targetCtx.drawImage(image, -w / 2, -h / 2, w, h); targetCtx.restore();
}
function drawCover(image, swayX = 0, swayY = 0, scaleBoost = 1) { drawCoverOnContext(ctx, image, mirrored, swayX, swayY, scaleBoost); }

function affineForTriangle(s0, s1, s2, t0, t1, t2) {
  const dx1 = s1.x - s0.x, dy1 = s1.y - s0.y, dx2 = s2.x - s0.x, dy2 = s2.y - s0.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 0.0001) return null;
  const a = ((t1.x - t0.x) * dy2 - (t2.x - t0.x) * dy1) / det;
  const c = ((t2.x - t0.x) * dx1 - (t1.x - t0.x) * dx2) / det;
  const b = ((t1.y - t0.y) * dy2 - (t2.y - t0.y) * dy1) / det;
  const d = ((t2.y - t0.y) * dx1 - (t1.y - t0.y) * dx2) / det;
  return { a, b, c, d, e: t0.x - a * s0.x - c * s0.y, f: t0.y - b * s0.x - d * s0.y };
}

function animatedFacePoints() {
  if (!faceBase?.length) return null;
  const p = faceBase.map(v => ({ x: v.x, y: v.y }));
  const t = avatarTime;
  const talk = Math.min(1, audioLevel * 1.9);
  const blink = Math.max(0, Math.sin(t * 0.42 - 0.7)) ** 36;
  const nod = Math.sin(t * 0.85) * (1.2 + talk * 2.0);
  const tilt = Math.sin(t * 0.63) * 0.008;
  const faceCx = (p[234]?.x + p[454]?.x) / 2 || canvas.width / 2;
  const faceCy = (p[10]?.y + p[152]?.y) / 2 || canvas.height / 2;
  const move = (idx, dx, dy) => { if (p[idx]) { p[idx].x += dx; p[idx].y += dy; } };
  const around = (idx, sx, sy) => {
    if (!p[idx]) return;
    const dx = p[idx].x - faceCx, dy = p[idx].y - faceCy;
    p[idx].x += dx * sx + dy * sy;
    p[idx].y += dy * sx - dx * sy;
  };
  // Whole-head micro motion.
  for (let i = 0; i < p.length; i++) {
    p[i].x += Math.sin(t * 0.9) * 0.8 + Math.sin(t * 1.7 + i * 0.02) * talk * 0.25;
    p[i].y += nod;
    around(i, 0.0001, tilt);
  }
  // Jaw/lips: speech drives a real landmark mesh rather than painting a mouth ellipse.
  const mouthOpen = Math.min(18, 1.5 + talk * (5 + Math.max(1, faceBase[152]?.y - faceBase[13]?.y) * 0.035));
  [13,14,12,15,16,17,18,19,20,21].forEach(i => move(i, 0, i === 14 || i === 17 || i === 18 ? mouthOpen : mouthOpen * 0.25));
  [78,308,95,324].forEach(i => move(i, 0, mouthOpen * 0.55));
  [152,149,150,176,148].forEach(i => move(i, 0, talk * 2.2));
  // Eyelid compression gives visible blinking while preserving the original eye texture.
  const leftEye = [33,133,159,145,160,144,158,153,155,154];
  const rightEye = [362,263,386,374,387,373,385,380,382,381];
  leftEye.forEach(i => move(i, 0, (p[i].y - faceCy) * blink * -0.03));
  rightEye.forEach(i => move(i, 0, (p[i].y - faceCy) * blink * -0.03));
  [70,63,105,66,107,336,296,334,293,300].forEach(i => move(i, 0, -blink * 0.4));
  return p;
}

function drawDeformedFace() {
  if (!img || !faceBase || !faceTriangles?.length) return;
  const target = animatedFacePoints();
  if (!target) return;
  ctx.save();
  // Draw the face mesh triangles over the original photo. The deformation is subtle
  // enough to keep skin texture intact while moving eyes, brows, lips and jaw together.
  for (const tri of faceTriangles) {
    const [ia, ib, ic] = tri;
    const s0 = faceBase[ia], s1 = faceBase[ib], s2 = faceBase[ic];
    const t0 = target[ia], t1 = target[ib], t2 = target[ic];
    const m = affineForTriangle(s0, s1, s2, t0, t1, t2);
    if (!m) continue;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t2.x, t2.y); ctx.closePath(); ctx.clip();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    const pad = 2;
    ctx.drawImage(sourceCanvas, -pad, -pad, sourceCanvas.width + pad * 2, sourceCanvas.height + pad * 2, -pad, -pad, sourceCanvas.width + pad * 2, sourceCanvas.height + pad * 2);
    ctx.restore();
  }
  ctx.restore();
}

function drawAvatar() {
  ctx.fillStyle = '#070b15'; ctx.fillRect(0, 0, canvas.width, canvas.height); if (!img) return;
  const t = avatarTime, talk = Math.min(1, audioLevel * 1.9);
  drawCover(img, Math.sin(t * 1.05) * (1 + talk * 1.5), Math.sin(t * .72) * (1 + talk), 1 + Math.sin(t * .55) * .002);
  if (avatarReady) drawDeformedFace();
  if (!avatarReady) { ctx.fillStyle = 'rgba(120,80,160,.25)'; ctx.fillRect(0,0,canvas.width,canvas.height); }
}

function animation() {
  avatarTime = performance.now() / 1000;
  if (analyser) {
    const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a); let sum = 0;
    for (const v of a) { const n = (v - 128) / 128; sum += n * n; }
    const target = Math.min(1, Math.sqrt(sum / a.length) * 5); audioLevel += (target - audioLevel) * .25;
  } else audioLevel *= .9;
  meterBar.style.width = `${Math.round(audioLevel * 100)}%`; talking.classList.toggle('hidden', !img || audioLevel < .035); drawAvatar();
  animationFrame = requestAnimationFrame(animation);
}
animation();

function robotCurve() { const n = 65536, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = Math.tanh(3 * x); } return c; }
function applyVoice() {
  if (!filter || !shaper) return;
  const m = { normal: [900, 0, 1], deep: [480, -7, .85], bright: [2600, 7, 1.2], robot: [1200, 2, 1] };
  const [f, g, q] = m[voiceMode];
  filter.frequency.value = f; filter.gain.value = g; filter.Q.value = q;
  shaper.curve = voiceMode === 'robot' ? robotCurve() : null;
}

async function setupAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  source = audioCtx.createMediaStreamSource(micStream);
  filter = audioCtx.createBiquadFilter(); filter.type = 'peaking';
  compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24; compressor.knee.value = 20; compressor.ratio.value = 8; compressor.attack.value = .003; compressor.release.value = .25;
  shaper = audioCtx.createWaveShaper(); shaper.oversample = '4x';
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
  destination = audioCtx.createMediaStreamDestination();
  source.connect(filter).connect(compressor).connect(shaper).connect(analyser);
  shaper.connect(destination); applyVoice(); processedStream = destination.stream;
  if (voiceEnabledEl.checked && uploadedVoiceReady) startVoiceClonePipeline();
}

async function startVoiceClonePipeline() {
  if (!micStream || voiceRecorder) return;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  try {
    voiceRecorder = new MediaRecorder(micStream, { mimeType: mime });
    voiceRecorder.ondataavailable = async e => {
      if (!e.data.size) return;
      try {
        const form = new FormData(); form.append('file', e.data, 'speech.webm');
        const r = await fetch(API + '/api/voice/convert', { method: 'POST', headers: { 'X-Guest-Id': guestId }, body: form });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || 'Voice conversion failed');
        const buf = await audioCtx.decodeAudioData(await r.arrayBuffer());
        const node = audioCtx.createBufferSource(); node.buffer = buf; node.connect(destination);
        const when = Math.max(audioCtx.currentTime + .02, voiceCloneQueueTime); node.start(when); voiceCloneQueueTime = when + buf.duration;
      } catch (err) { console.warn(err); }
    };
    voiceRecorder.start(2800);
  } catch { voiceStatusEl.textContent = 'Uploaded voice conversion is unavailable in this browser.'; }
}
function stopVoiceClonePipeline() { try { voiceRecorder?.stop(); } catch {} voiceRecorder = null; voiceCloneQueueTime = 0; }

voiceFileEl.onchange = async () => {
  const f = voiceFileEl.files?.[0]; if (!f) return;
  if (f.size > 12 * 1024 * 1024) return voiceStatusEl.textContent = 'Voice sample must be 12MB or smaller.';
  if (!f.type.startsWith('audio/')) return voiceStatusEl.textContent = 'Choose an audio file.';
  voiceStatusEl.textContent = 'Uploading voice…';
  try {
    const form = new FormData(); form.append('file', f, f.name);
    const r = await fetch(API + '/api/voice/clone', { method: 'POST', headers: { 'X-Guest-Id': guestId }, body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'Voice cloning failed.');
    uploadedVoiceReady = !!d.ready; voiceEnabledEl.checked = uploadedVoiceReady;
    voiceStatusEl.textContent = uploadedVoiceReady ? 'Uploaded voice is ready.' : 'Voice submitted; provider verification may be required.';
    if (uploadedVoiceReady && micStream) { stopVoiceClonePipeline(); startVoiceClonePipeline(); }
  } catch (e) { voiceStatusEl.textContent = e.message; }
};

voiceEnabledEl.onchange = () => {
  if (voiceEnabledEl.checked && !uploadedVoiceReady) { voiceEnabledEl.checked = false; voiceStatusEl.textContent = 'Upload and validate a voice first.'; return; }
  if (voiceEnabledEl.checked) startVoiceClonePipeline(); else stopVoiceClonePipeline();
};

async function startMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  await setupAudio();
  $('#mic').textContent = '⏹ Stop microphone'; $('#mute').disabled = false; say('Microphone ready. Your uploaded photo is now a live animated avatar.');
}

$('#mic').onclick = async () => {
  try {
    if (micStream) {
      stopVoiceClonePipeline(); micStream.getTracks().forEach(t => t.stop()); micStream = null; processedStream = null;
      if (audioCtx) await audioCtx.close().catch(() => {}); audioCtx = null; analyser = null;
      $('#mic').textContent = '🎙 Start microphone'; $('#mute').disabled = true;
    } else await startMic();
  } catch (e) { say(`Microphone error: ${e.message}`); }
};

$('#mute').onclick = () => { if (!micStream) return; muted = !muted; micStream.getAudioTracks().forEach(t => t.enabled = !muted); $('#mute').textContent = muted ? '🎙 Unmute' : '🔇 Mute'; };

function makePeer() {
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = e => e.candidate && sendSignal('ice-candidate', { candidate: e.candidate });
  pc.ontrack = e => { remote.srcObject = e.streams[0]; $('#remoteState').textContent = 'Connected — live avatar + processed voice'; startTimer(); remote.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { if (!pc) return; $('#remoteState').textContent = `Connection: ${pc.connectionState}`; if (['failed','closed'].includes(pc.connectionState)) cleanup(false); };
  pc.oniceconnectionstatechange = () => { if (pc?.iceConnectionState === 'failed') say('WebRTC ICE failed. Check TURN configuration.'); };
}

async function outgoing() {
  if (avatarEnabledEl.checked && !img) throw new Error('Upload a human photo first.');
  if (!micStream) await startMic();
  const videoStream = avatarEnabledEl.checked ? canvas.captureStream(30) : new MediaStream();
  const audioTracks = processedStream?.getAudioTracks() || [];
  if (!audioTracks.length) throw new Error('Processed microphone audio is unavailable.');
  return new MediaStream([...videoStream.getVideoTracks(), ...audioTracks]);
}

$('#call').onclick = async () => {
  try {
    const room = $('#room').value.trim();
    if (!room) throw new Error('Enter a room code.');
    if (roomJoined) throw new Error('Already in a room.');
    outgoingStream = await outgoing();
    makePeer();
    outgoingStream.getTracks().forEach(t => pc.addTrack(t, outgoingStream));
    await joinRoom();
    $('#call').disabled = true; $('#hang').disabled = false; $('#room').disabled = true;
    say('Live avatar call started. Share the room/invite with your PhotoCall partner.');
  } catch (e) { say(e.message); pc?.close(); pc = null; }
};

function inviteText() {
  const url = new URL('/receiver.html?room=' + encodeURIComponent($('#room').value.trim()), window.location.href).href;
  return `Join my PhotoCall call: ${url}\nRoom: ${$('#room').value.trim()}`;
}

$('#connectSignal').onclick = async () => {
  const text = inviteText();
  try {
    if (window.PhotoCallAndroid?.connectSignal) { window.PhotoCallAndroid.connectSignal(text); say('Signal opened.'); return; }
    if (navigator.share) { await navigator.share({ title: 'PhotoCall call', text }); say('Share opened. Choose Signal.'); }
    else { await navigator.clipboard.writeText(text); say('Invite copied. Open Signal and send it to your friend.'); }
  } catch (e) {
    if (e.name !== 'AbortError') { try { await navigator.clipboard.writeText(text); } catch {} say('Signal share was unavailable; invite copied when possible.'); }
  }
};
$('#shareSignal').onclick = () => $('#connectSignal').click();

function startTimer() { timerStart = Date.now(); clearInterval(timerHandle); timerHandle = setInterval(() => { const s = Math.floor((Date.now() - timerStart) / 1000); $('#callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`; }, 500); }
function stopTimer() { clearInterval(timerHandle); timerHandle = null; $('#callTimer').textContent = '00:00'; }
async function cleanup(emit = true) { if (emit && roomJoined) { try { await sendSignal('call-ended'); } catch {} } clearInterval(pollTimer); pollTimer = null; roomJoined = false; pc?.close(); pc = null; outgoingStream?.getTracks().forEach(t => t.stop()); outgoingStream = null; remote.srcObject = null; $('#call').disabled = false; $('#hang').disabled = true; $('#room').disabled = false; $('#remoteState').textContent = 'Waiting for connection…'; stopTimer(); }
$('#hang').onclick = () => cleanup(true);
$('#copyRoom').onclick = async () => { try { await navigator.clipboard.writeText($('#room').value.trim()); say('Room code copied.'); } catch { say('Copy failed.'); } };

document.querySelectorAll('.voice').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.voice').forEach(x => x.classList.remove('active')); button.classList.add('active'); voiceMode = button.dataset.voice || 'normal'; applyVoice(); }));

boot();

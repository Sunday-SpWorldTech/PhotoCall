const $ = (s) => document.querySelector(s);

const candidates = [...new Set([
  '/api',
  import.meta.env.VITE_API_URL,
  import.meta.env.VITE_PRODUCTION_API_URL,
  'https://photocall-backend.vercel.app'
].filter(Boolean).map(v => String(v).replace(/\/$/, '')))];

let API = candidates[0] || '/api';
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
let animationFrame = 0, avatarTime = 0, lastRenderAt = 0;
const AVATAR_FPS = 30;
let mouthOpenSmooth = 0, blinkSmoothL = 0, blinkSmoothR = 0, headYawSmooth = 0, headPitchSmooth = 0, headRollSmooth = 0;
let faceControlVideo = null, liveLandmarks = null, liveNeutral = null, liveBlendshapes = null, faceControlActive = false, faceControlBusy = false, faceControlLastVideoTime = -1, faceControlLandmarker = null, faceControlLastDetectAt = 0;

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
const roomInput = $('#room');
roomInput.value = `room-${crypto.randomUUID().slice(0, 8)}`;

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
        if (r.ok) {
          API = base;
          const body = await r.json().catch(() => ({}));
          if (body.database === 'error' || body.database === 'unavailable') console.warn('PhotoCall backend database:', body.database);
          return;
        }
        last = new Error(`${base}${path} returned ${r.status}`);
      } catch (e) { last = e; }
    }
  }
  throw new Error(`PhotoCall backend is unreachable. ${last?.message || 'Check the Vercel backend deployment and VITE_API_URL.'}`);
}

async function api(path, options = {}) {
  const ordered = [API, ...candidates.filter(v => v !== API)];
  let lastError;
  for (const base of ordered) {
    try {
      const r = await fetchTimeout(base + path, options, 20000);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { API = base; return d; }
      lastError = new Error(d.message || `Request failed (${r.status})`);
      if (r.status >= 500 || r.status === 404 || r.status === 502 || r.status === 503) continue;
      throw lastError;
    } catch (e) { lastError = e; }
  }
  throw new Error(lastError?.message || 'PhotoCall backend is unavailable.');
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
  pollTimer = setInterval(pollEvents, 450);
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
  status('Connecting…');
  try {
    await discoverBackend();
    status('Backend API online', true);
  } catch (e) {
    console.error(e);
    status('Backend offline');
    say(e.message || 'PhotoCall backend is unavailable.');
    return;
  }

  // Avatar creation is client-side and must remain usable even if the optional
  // database/session layer is temporarily unavailable. This prevents a backend
  // session problem from incorrectly blocking photo animation.
  try {
    await startGuestSession();
    await loadConfig();
    status('Ready', true);
    say('PhotoCall is ready. Upload a clear human photo, start face control, then move your face to control the avatar.');
  } catch (e) {
    console.warn('Backend session/config unavailable:', e);
    status('Backend API online • database unavailable', true);
    say('Avatar preview is ready. Calling and voice services need the backend database/provider configuration.');
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
  const VISION_VERSION = '1.0.1';
  const loaders = [
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/+esm`,
    `https://esm.sh/@mediapipe/tasks-vision@${VISION_VERSION}`
  ];
  if (!window._photoCallVisionPromise) {
    window._photoCallVisionPromise = (async () => {
      let lastError;
      for (const url of loaders) {
        try { return await import(url); } catch (e) { lastError = e; }
      }
      throw new Error(`MediaPipe Vision could not load. ${lastError?.message || ''}`.trim());
    })();
  }
  const { FaceLandmarker, FilesetResolver } = await window._photoCallVisionPromise;
  const vision = await FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`);
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
    await landmarker.setOptions({ runningMode: 'IMAGE' });
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
    photoValidation.textContent = `Human face detected: ${landmarks.length} landmarks. Live avatar animation ready — eyes, brows, lips, jaw and head movement enabled.`;
    avatarReady = true;
    $('#faceControl').disabled = false;
    return true;
  } catch (e) {
    console.error('Face landmark engine:', e);
    avatarReady = false;
    photoValidation.textContent = `Face animation could not initialize: ${e.message}`;
    return false;
  }
}


function ensureFaceControlVideo() {
  if (faceControlVideo) return faceControlVideo;
  faceControlVideo = document.createElement('video');
  faceControlVideo.autoplay = true;
  faceControlVideo.muted = true;
  faceControlVideo.playsInline = true;
  faceControlVideo.style.position = 'fixed';
  faceControlVideo.style.right = '18px';
  faceControlVideo.style.bottom = '18px';
  faceControlVideo.style.width = '180px';
  faceControlVideo.style.height = '135px';
  faceControlVideo.style.objectFit = 'cover';
  faceControlVideo.style.borderRadius = '14px';
  faceControlVideo.style.zIndex = '50';
  faceControlVideo.style.display = 'none';
  faceControlVideo.setAttribute('aria-label', 'Face control camera preview');
  document.body.appendChild(faceControlVideo);
  return faceControlVideo;
}

async function startFaceControl() {
  if (faceControlActive) return true;
  if (!img || !avatarReady) throw new Error('Upload a valid human photo first.');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.');
  const video = ensureFaceControlVideo();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  const landmarker = await loadFaceLandmarker();
  await landmarker.setOptions({ runningMode: 'VIDEO' });
  faceControlLandmarker = landmarker;
  faceControlActive = true;
  faceControlVideo.style.display = 'block';
  faceControlLastVideoTime = -1;
  liveNeutral = null;
  liveBlendshapes = null;
  $('#faceControlStatus').textContent = 'Face control active — move your head, eyes and mouth.';
  $('#faceControlStatus').className = 'message online-message';
  $('#faceControl').textContent = '⏹ Stop face control';
  requestFaceTracking();
  return true;
}

function stopFaceControl() {
  faceControlActive = false;
  faceControlBusy = false;
  liveLandmarks = null;
  liveNeutral = null;
  liveBlendshapes = null;
  if (faceControlVideo?.srcObject) faceControlVideo.srcObject.getTracks().forEach(t => t.stop());
  if (faceControlVideo) { faceControlVideo.srcObject = null; faceControlVideo.style.display = 'none'; }
  $('#faceControl').textContent = '🎥 Start face control';
  $('#faceControlStatus').textContent = 'Face control is off.';
  $('#faceControlStatus').className = 'message';
}

function requestFaceTracking() {
  if (!faceControlActive || !faceControlVideo) return;
  const video = faceControlVideo;
  const tick = async (now = performance.now()) => {
    if (!faceControlActive) return;
    // MediaPipe inference is deliberately throttled to keep the render loop responsive.
    if (!faceControlBusy && video.readyState >= 2 && video.currentTime !== faceControlLastVideoTime && now - faceControlLastDetectAt >= 33) {
      faceControlBusy = true;
      faceControlLastVideoTime = video.currentTime;
      faceControlLastDetectAt = now;
      try {
        const result = faceControlLandmarker.detectForVideo(video, now);
        const lm = result.faceLandmarks?.[0];
        if (lm?.length >= 400) {
          if (!liveNeutral) liveNeutral = lm.map(p => ({ x: p.x, y: p.y, z: p.z || 0 }));
          liveLandmarks = lm;
          liveBlendshapes = result.faceBlendshapes?.[0]?.categories || null;
          updateExpressionState(lm, liveBlendshapes);
          $('#faceControlStatus').textContent = 'Face control active — your eyes, eyebrows, lips, jaw and head are controlling the avatar.';
        } else {
          liveLandmarks = null;
          $('#faceControlStatus').textContent = 'Face control active — move closer and face the camera.';
        }
      } catch (e) {
        console.warn('Face tracking:', e);
      } finally { faceControlBusy = false; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function blend(name, fallback = 0) {
  const item = liveBlendshapes?.find(x => x.categoryName === name);
  return item ? Number(item.score || 0) : fallback;
}

function updateExpressionState(lm, blendshapes = null) {
  const d = (a,b) => Math.hypot((lm[a]?.x||0)-(lm[b]?.x||0), (lm[a]?.y||0)-(lm[b]?.y||0));
  const mouthW = Math.max(.001, d(61,291));
  const mouthH = d(13,14);
  const leftEyeW = Math.max(.001, d(33,133));
  const rightEyeW = Math.max(.001, d(362,263));
  const leftOpen = d(159,145) / leftEyeW;
  const rightOpen = d(386,374) / rightEyeW;
  const blendMouth = blend('jawOpen', 0);
  const blendBlinkL = blend('eyeBlinkLeft', 0);
  const blendBlinkR = blend('eyeBlinkRight', 0);
  mouthOpenSmooth += ((Math.max(Math.min(mouthH / mouthW, .24), blendMouth * .72) - mouthOpenSmooth) * .24);
  blinkSmoothL += (Math.max(leftOpen, (1 - blendBlinkL) * .08) - blinkSmoothL) * .35;
  blinkSmoothR += (Math.max(rightOpen, (1 - blendBlinkR) * .08) - blinkSmoothR) * .35;
  const leftEye = lm[33], rightEye = lm[263], nose = lm[1];
  if (leftEye && rightEye && nose) {
    const midX = (leftEye.x + rightEye.x) / 2;
    const midY = (leftEye.y + rightEye.y) / 2;
    headYawSmooth += (((nose.x - midX) / Math.max(.001, Math.abs(rightEye.x-leftEye.x))) - headYawSmooth) * .25;
    headPitchSmooth += (((nose.y - midY) / Math.max(.001, Math.abs(rightEye.x-leftEye.x))) - headPitchSmooth) * .25;
    headRollSmooth += ((Math.atan2(rightEye.y-leftEye.y, rightEye.x-leftEye.x)) - headRollSmooth) * .25;
  }
}

function liveControlledFacePoints() {
  if (!faceBase?.length || !liveLandmarks?.length || !liveNeutral?.length) return null;
  const p = faceBase.map(v => ({ x: v.x, y: v.y }));
  const get = (arr, i) => arr[i] || arr[0];
  const baseLeft = get(faceBase, 234), baseRight = get(faceBase, 454);
  const baseTop = get(faceBase, 10), baseBottom = get(faceBase, 152);
  const baseW = Math.max(100, Math.abs(baseRight.x - baseLeft.x));
  const baseH = Math.max(120, Math.abs(baseBottom.y - baseTop.y));
  const liveW = Math.max(.08, Math.abs(get(liveLandmarks,454).x - get(liveLandmarks,234).x));
  const neutralW = Math.max(.08, Math.abs(get(liveNeutral,454).x - get(liveNeutral,234).x));
  const scale = Math.min(1.16, Math.max(.86, neutralW / liveW));
  const lc = { x:(get(liveLandmarks,234).x+get(liveLandmarks,454).x)/2, y:(get(liveLandmarks,10).y+get(liveLandmarks,152).y)/2 };
  const nc = { x:(get(liveNeutral,234).x+get(liveNeutral,454).x)/2, y:(get(liveNeutral,10).y+get(liveNeutral,152).y)/2 };
  const dxHead = (lc.x-nc.x) * baseW * 0.72;
  const dyHead = (lc.y-nc.y) * baseH * 0.72;

  for (let i=0;i<p.length;i++) {
    const d=liveLandmarks[i], n=liveNeutral[i];
    if (!d || !n) continue;
    // Expression displacement: preserve the target photo proportions while transferring
    // the user's local expression changes onto the photo.
    p[i].x += (d.x-n.x) * baseW * 1.15;
    p[i].y += (d.y-n.y) * baseH * 1.15;
  }

  // Global head pose: translation + scale + rotation around the photo's face center.
  const yaw = Math.max(-.16, Math.min(.16, headYawSmooth)) * 0.62;
  const pitch = Math.max(-.14, Math.min(.14, headPitchSmooth-.32)) * 0.55;
  const roll = Math.max(-.28, Math.min(.28, headRollSmooth)) * 0.48;
  const cx = (baseLeft.x+baseRight.x)/2, cy = (baseTop.y+baseBottom.y)/2;
  const cos=Math.cos(roll), sin=Math.sin(roll);
  for (let i=0;i<p.length;i++) {
    let x=cx+(p[i].x-cx)*scale, y=cy+(p[i].y-cy)*scale;
    x += dxHead + yaw*baseW*(.22 - Math.abs((faceBase[i]?.y||cy)-cy)/baseH*.08);
    y += dyHead + pitch*baseH*.18;
    const rx=x-cx, ry=y-cy;
    p[i].x=cx+rx*cos-ry*sin;
    p[i].y=cy+rx*sin+ry*cos;
  }
  return p;
}

function loadPhoto() {
  stopFaceControl();
  liveLandmarks = null; liveNeutral = null; liveBlendshapes = null;
  if (!photos.length) {
    img = null; faceBox = null; faceLandmarks = null; faceTriangles = null; faceBase = null; avatarReady = false;
    hint.classList.remove('hidden'); $('#photoInfo').textContent = 'No photo selected';
    photoValidation.textContent = 'Photo check: waiting for an image.'; return;
  }
  hint.classList.add('hidden'); $('#photoInfo').textContent = `${selected + 1} / ${photos.length} selected`;
  img = new Image(); img.onload = async () => {
    const valid = await validateHumanPhoto(img);
    drawAvatar();
    if (valid) { $('#faceControlStatus').textContent = 'Photo avatar is ready. Click “Start face control” and allow camera access to control it with your face.'; }
  }; img.src = photos[selected].url;
}

files.onchange = e => {
  const picked = [...e.target.files].filter(f => /^image\/(jpeg|png|webp)$/.test(f.type));
  picked.forEach(file => photos.push({ url: URL.createObjectURL(file), name: file.name, file }));
  if (picked.length) { selected = photos.length - 1; galleryRender(); loadPhoto(); say(`${picked.length} photo${picked.length === 1 ? '' : 's'} ready. PhotoCall is turning the face into a live 2D avatar puppet.`); }
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
  if (liveLandmarks && liveNeutral) return liveControlledFacePoints();

  // No camera control yet: keep a very small idle animation so the preview is
  // clearly an avatar, but never pretend this is user face tracking.
  const p = faceBase.map(v => ({ x: v.x, y: v.y }));
  const t = avatarTime;
  const talk = Math.min(1, audioLevel * 2.0);
  const blink = Math.pow(Math.max(0, Math.sin(t * 1.1 - 1.2)), 30);
  const faceCx = (p[234]?.x + p[454]?.x) / 2 || canvas.width / 2;
  const faceCy = (p[10]?.y + p[152]?.y) / 2 || canvas.height / 2;
  const faceH = Math.max(100, Math.abs((p[152]?.y || faceCy) - (p[10]?.y || faceCy)));
  const move = (i, dx, dy) => { if (p[i]) { p[i].x += dx; p[i].y += dy; } };
  [159,160,161,158,145,144,153,154,386,387,388,385,374,373,380,381].forEach(i => move(i, 0, blink * Math.max(2, faceH * 0.012)));
  [70,63,105,66,107,336,296,334,293,300].forEach(i => move(i, 0, -Math.max(0, Math.sin(t * 1.2)) * 2.0));
  const mouth = faceH * (0.006 + talk * 0.045);
  [13,12,15,16].forEach(i => move(i, 0, -mouth * 0.45));
  [14,17,18,19,20,21].forEach(i => move(i, 0, mouth * 0.65));
  [152,149,150,176,148].forEach(i => move(i, 0, talk * faceH * 0.006));
  return p;
}

function drawDeformedFace() {
  if (!img || !faceBase || !faceTriangles?.length) return;
  const target = animatedFacePoints();
  if (!target) return;
  const xs=faceBase.map(p=>p.x), ys=faceBase.map(p=>p.y);
  const minX=Math.max(0, Math.floor(Math.min(...xs)-24)), minY=Math.max(0, Math.floor(Math.min(...ys)-24));
  const maxX=Math.min(canvas.width, Math.ceil(Math.max(...xs)+24)), maxY=Math.min(canvas.height, Math.ceil(Math.max(...ys)+24));
  const sw=Math.max(1,maxX-minX), sh=Math.max(1,maxY-minY);
  ctx.save();
  for (const tri of faceTriangles) {
    const [ia,ib,ic]=tri, s0=faceBase[ia],s1=faceBase[ib],s2=faceBase[ic],t0=target[ia],t1=target[ib],t2=target[ic];
    const m=affineForTriangle(s0,s1,s2,t0,t1,t2); if(!m) continue;
    const triMinX=Math.max(minX,Math.floor(Math.min(t0.x,t1.x,t2.x)-2));
    const triMinY=Math.max(minY,Math.floor(Math.min(t0.y,t1.y,t2.y)-2));
    const triMaxX=Math.min(maxX,Math.ceil(Math.max(t0.x,t1.x,t2.x)+2));
    const triMaxY=Math.min(maxY,Math.ceil(Math.max(t0.y,t1.y,t2.y)+2));
    ctx.save();
    ctx.beginPath();ctx.moveTo(t0.x,t0.y);ctx.lineTo(t1.x,t1.y);ctx.lineTo(t2.x,t2.y);ctx.closePath();ctx.clip();
    ctx.setTransform(m.a,m.b,m.c,m.d,m.e,m.f);
    // sourceCanvas and faceBase share the same canvas coordinate system. Draw the
    // complete source under the affine transform; cropping here breaks the
    // source-to-target mapping and creates the large polygon seen in the preview.
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.restore();
  }
  ctx.restore();
  drawAnimatedMouth(target);
  drawAnimatedEyes(target);
}

function facePoint(points,i){ return points[i] || {x:canvas.width/2,y:canvas.height/2}; }
function polygon(points, ids){ ctx.beginPath(); ids.forEach((id,i)=>{const p=facePoint(points,id); if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);}); ctx.closePath(); }
function drawAnimatedMouth(target){
  if(!liveLandmarks || !liveNeutral) return;
  const open=Math.max(0,Math.min(1,(mouthOpenSmooth-.025)/.16));
  if(open<.035) return;
  const upper=[61,185,40,39,37,0,267,269,270,409,291];
  const lower=[291,375,321,314,17,84,181,91,61];
  const mouth=upper.map(i=>facePoint(target,i));
  const inner=[78,191,80,81,82,13,312,311,310,415,308,14,87,178,88].map(i=>facePoint(target,i));
  const left=facePoint(target,61), right=facePoint(target,291), top=facePoint(target,13), bottom=facePoint(target,14);
  const cx=(left.x+right.x)/2, cy=(top.y+bottom.y)/2;
  const scale=Math.max(1,open*1.2);
  ctx.save();
  polygon(target, inner); ctx.fillStyle='rgba(25,7,10,.88)'; ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx,cy,Math.max(3,(right.x-left.x)*.25),Math.max(2,(bottom.y-top.y)*.48*scale),0,0,Math.PI*2);
  ctx.fillStyle='rgba(18,5,8,.96)';ctx.fill();
  if(open>.25){
    ctx.beginPath();ctx.ellipse(cx,cy-(bottom.y-top.y)*.16,Math.max(4,(right.x-left.x)*.20),Math.max(2,(bottom.y-top.y)*.16),0,0,Math.PI*2);ctx.fillStyle='rgba(245,245,240,.9)';ctx.fill();
  }
  ctx.restore();
}
function drawAnimatedEyes(target){
  if(!liveLandmarks) return;
  const eyes=[{top:159,bottom:145,left:33,right:133,open:blinkSmoothL},{top:386,bottom:374,left:362,right:263,open:blinkSmoothR}];
  for(const e of eyes){
    const openness=Math.max(0,Math.min(1,(e.open-.018)/.09));
    if(openness>.35) continue;
    const a=facePoint(target,e.left),b=facePoint(target,e.right),t=facePoint(target,e.top),d=facePoint(target,e.bottom);
    const cx=(a.x+b.x)/2,cy=(t.y+d.y)/2;
    ctx.save();ctx.beginPath();ctx.ellipse(cx,cy,Math.max(5,Math.abs(b.x-a.x)*.38),Math.max(2,Math.abs(d.y-t.y)*.32),0,0,Math.PI*2);ctx.fillStyle='rgba(92,58,45,.5)';ctx.fill();ctx.restore();
  }
}

function drawAvatar() {
  ctx.fillStyle = '#070b15'; ctx.fillRect(0, 0, canvas.width, canvas.height); if (!img) return;
  drawCover(img, 0, 0, 1);
  if (avatarReady) drawDeformedFace();
  if (!avatarReady) { ctx.fillStyle = 'rgba(120,80,160,.25)'; ctx.fillRect(0,0,canvas.width,canvas.height); }
}

function animation(now = performance.now()) {
  avatarTime = now / 1000;
  if (analyser) {
    const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a); let sum = 0;
    for (const v of a) { const n = (v - 128) / 128; sum += n * n; }
    const target = Math.min(1, Math.sqrt(sum / a.length) * 5); audioLevel += (target - audioLevel) * .25;
  } else audioLevel *= .9;
  meterBar.style.width = `${Math.round(audioLevel * 100)}%`; talking.classList.toggle('hidden', !img || audioLevel < .035);
  if (now-lastRenderAt >= 1000/AVATAR_FPS) { drawAvatar(); lastRenderAt=now; }
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

async function fetchWithApiFallback(path, options = {}) {
  const ordered = [API, ...candidates.filter(v => v !== API)];
  let last;
  for (const base of ordered) {
    try {
      const r = await fetchTimeout(base + path, options, 30000);
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 404)) { API = base; return r; }
      last = new Error(`Backend returned ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last || new Error('Backend is unavailable.');
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
        const response = await fetchWithApiFallback('/api/voice/convert', { method: 'POST', headers: { 'X-Guest-Id': guestId }, body: form });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || `Voice conversion failed (${response.status})`);
        const buf = await audioCtx.decodeAudioData(await response.arrayBuffer());
        const node = audioCtx.createBufferSource(); node.buffer = buf; node.connect(destination);
        const when = Math.max(audioCtx.currentTime + .02, voiceCloneQueueTime); node.start(when); voiceCloneQueueTime = when + buf.duration;
      } catch (err) { console.warn(err); }
    };
    voiceRecorder.start(2800);
  } catch { voiceStatusEl.textContent = 'Uploaded voice conversion is unavailable in this browser.'; }
}
function stopVoiceClonePipeline() { try { voiceRecorder?.stop(); } catch {} voiceRecorder = null; voiceCloneQueueTime = 0; }

$('#faceControl').onclick = async () => {
  try { if (faceControlActive) stopFaceControl(); else await startFaceControl(); }
  catch (e) { $('#faceControlStatus').textContent = `Face control error: ${e.message}`; say(e.message); }
};

voiceFileEl.onchange = async () => {
  const f = voiceFileEl.files?.[0]; if (!f) return;
  if (f.size > 12 * 1024 * 1024) return voiceStatusEl.textContent = 'Voice sample must be 12MB or smaller.';
  if (!f.type.startsWith('audio/')) return voiceStatusEl.textContent = 'Choose an audio file.';
  voiceStatusEl.textContent = 'Uploading voice…';
  try {
    const form = new FormData(); form.append('file', f, f.name);
    const r = await fetchWithApiFallback('/api/voice/clone', { method: 'POST', headers: { 'X-Guest-Id': guestId }, body: form });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || `Voice cloning failed (${r.status}).`);
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
  $('#mic').textContent = '⏹ Stop microphone'; $('#mute').disabled = false; say('Microphone ready. Your avatar will speak when you speak; face control drives the facial movement.');
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


async function testVoice() {
  if (!micStream) await startMic();
  const statusEl = voiceStatusEl;
  statusEl.textContent = 'Recording a short voice test…';
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(micStream, { mimeType: mime });
  const chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve, reject) => { recorder.onstop = resolve; recorder.onerror = () => reject(new Error('Voice recorder failed.')); });
  recorder.start();
  setTimeout(() => { try { recorder.stop(); } catch {} }, 2200);
  await done;
  const blob = new Blob(chunks, { type: mime });
  try {
    if (voiceEnabledEl.checked && uploadedVoiceReady) {
      const form = new FormData(); form.append('file', blob, 'voice-test.webm');
      const r = await fetchWithApiFallback('/api/voice/convert', { method: 'POST', headers: { 'X-Guest-Id': guestId }, body: form });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `Voice conversion failed (${r.status}).`);
      const audio = new Audio(URL.createObjectURL(await r.blob()));
      await audio.play();
    } else {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    }
    statusEl.textContent = 'Voice test played successfully. You can start the call.';
  } catch (e) {
    statusEl.textContent = `Voice test failed: ${e.message}`;
  }
}
$('#testVoice').onclick = async () => { try { await testVoice(); } catch (e) { say(`Voice test error: ${e.message}`); } };

function makePeer() {
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = e => e.candidate && sendSignal('ice-candidate', { candidate: e.candidate });
  pc.ontrack = e => { remote.srcObject = e.streams[0]; $('#remoteState').textContent = 'Connected — live avatar + processed voice'; startTimer(); remote.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { if (!pc) return; $('#remoteState').textContent = `Connection: ${pc.connectionState}`; if (['failed','closed'].includes(pc.connectionState)) cleanup(false); };
  pc.oniceconnectionstatechange = () => { if (pc?.iceConnectionState === 'failed') say('WebRTC ICE failed. Check TURN configuration.'); };
}

async function outgoing() {
  if (avatarEnabledEl.checked && !img) throw new Error('Upload a human photo first.');
  if (avatarEnabledEl.checked && !faceControlActive) await startFaceControl();
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
async function cleanup(emit = true) { stopFaceControl(); if (emit && roomJoined) { try { await sendSignal('call-ended'); } catch {} } clearInterval(pollTimer); pollTimer = null; roomJoined = false; pc?.close(); pc = null; outgoingStream?.getTracks().forEach(t => t.stop()); outgoingStream = null; remote.srcObject = null; $('#call').disabled = false; $('#hang').disabled = true; $('#room').disabled = false; $('#remoteState').textContent = 'Waiting for connection…'; stopTimer(); }
$('#hang').onclick = () => cleanup(true);
$('#copyRoom').onclick = async () => { try { await navigator.clipboard.writeText($('#room').value.trim()); say('Room code copied.'); } catch { say('Copy failed.'); } };

document.querySelectorAll('.voice').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.voice').forEach(x => x.classList.remove('active')); button.classList.add('active'); voiceMode = button.dataset.voice || 'normal'; applyVoice(); }));

boot();

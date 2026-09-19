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
let faceBox = null;
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

async function validateHumanPhoto(image) {
  photoValidation.textContent = 'Photo check: detecting human face…';
  faceBox = null;
  try {
    if (window.Human?.Human) {
      if (!window._photoCallHuman) {
        window._photoCallHuman = new window.Human.Human({
          backend: 'webgl',
          modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/',
          face: { enabled: true, detector: { rotation: false, return: true }, mesh: { enabled: false }, iris: { enabled: false }, description: { enabled: false }, emotion: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false } },
          body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false }, debug: false
        });
        await window._photoCallHuman.load();
        await window._photoCallHuman.warmup();
      }
      const result = await window._photoCallHuman.detect(image);
      if (!Array.isArray(result.face) || !result.face.length) throw new Error('No human face detected');
      const box = result.face[0].box;
      if (box && box.length >= 4) faceBox = box;
      photoValidation.textContent = 'Human face detected. Live avatar animation is ready.';
      return true;
    }
  } catch (e) { console.warn('Face detection:', e); }
  photoValidation.textContent = 'Photo loaded. Use a clear front-facing human photo.';
  return true;
}

function loadPhoto() {
  if (!photos.length) {
    img = null; faceBox = null; hint.classList.remove('hidden');
    $('#photoInfo').textContent = 'No photo selected';
    photoValidation.textContent = 'Photo check: waiting for an image.';
    return;
  }
  hint.classList.add('hidden');
  $('#photoInfo').textContent = `${selected + 1} / ${photos.length} selected`;
  img = new Image();
  img.onload = async () => { await validateHumanPhoto(img); drawAvatar(); };
  img.src = photos[selected].url;
}

files.onchange = e => {
  const picked = [...e.target.files].filter(f => /^image\/(jpeg|png|webp)$/.test(f.type));
  picked.forEach(file => photos.push({ url: URL.createObjectURL(file), name: file.name, file }));
  if (picked.length) {
    selected = photos.length - 1;
    galleryRender();
    loadPhoto();
    say(`${picked.length} photo${picked.length === 1 ? '' : 's'} ready. Start your microphone to animate the avatar.`);
  }
};

$('#flip').onclick = () => { mirrored = !mirrored; drawAvatar(); };
$('#reset').onclick = () => { photos.forEach(p => URL.revokeObjectURL(p.url)); photos = []; selected = 0; loadPhoto(); galleryRender(); say('Avatar reset.'); };

function drawCover(image, swayX = 0, swayY = 0, scaleBoost = 1) {
  const cw = canvas.width, ch = canvas.height;
  const scale = Math.max(cw / image.width, ch / image.height) * scaleBoost;
  const w = image.width * scale, h = image.height * scale;
  ctx.save();
  ctx.translate(cw / 2 + swayX, ch / 2 + swayY);
  ctx.scale(mirrored ? -1 : 1, 1);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawAvatar() {
  ctx.fillStyle = '#070b15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!img) return;

  const t = avatarTime;
  const talkingAmount = Math.min(1, audioLevel * 1.7);
  const swayX = Math.sin(t * 1.15) * (1.5 + talkingAmount * 2.5);
  const swayY = Math.sin(t * 0.75) * (1 + talkingAmount * 1.5);
  const zoom = 1 + Math.sin(t * 0.9) * 0.004;
  drawCover(img, swayX, swayY, zoom);

  // Lightweight photo-puppet animation: mouth movement, blink and breathing/head motion.
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.69;
  const mouthOpen = 3 + talkingAmount * 28 + Math.abs(Math.sin(t * 7.5)) * talkingAmount * 8;
  const blink = Math.pow(Math.max(0, Math.sin(t * 0.55 - 1.3)), 32);

  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = '#160b14';
  ctx.beginPath();
  ctx.ellipse(cx, cy + swayY, 38 + talkingAmount * 4, mouthOpen, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = '#f2b6b6';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy + swayY);
  ctx.quadraticCurveTo(cx, cy + swayY + talkingAmount * 9, cx + 28, cy + swayY);
  ctx.stroke();

  if (blink > 0.8) {
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#080b15';
    ctx.fillRect(cx - 118, cy - 116, 72, 10);
    ctx.fillRect(cx + 46, cy - 116, 72, 10);
  }
  ctx.restore();
}

function animation() {
  avatarTime = performance.now() / 1000;
  if (analyser) {
    const a = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(a);
    let sum = 0;
    for (const v of a) { const n = (v - 128) / 128; sum += n * n; }
    const target = Math.min(1, Math.sqrt(sum / a.length) * 5);
    audioLevel += (target - audioLevel) * .25;
  } else audioLevel *= .9;
  meterBar.style.width = `${Math.round(audioLevel * 100)}%`;
  talking.classList.toggle('hidden', !img || audioLevel < .035);
  drawAvatar();
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

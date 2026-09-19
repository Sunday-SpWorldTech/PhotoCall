import { io } from 'socket.io-client';
const $ = s => document.querySelector(s);
const PRODUCTION_API = import.meta.env.VITE_PRODUCTION_API_URL || 'https://photocall-backend.vercel.app';
const configuredApi = import.meta.env.VITE_API_URL;
const configuredSocket = import.meta.env.VITE_SOCKET_URL;
const isProductionHost = window.location.hostname === 'photocall-frontend.vercel.app';
const API = (isProductionHost ? PRODUCTION_API : (configuredApi || PRODUCTION_API)).replace(/\/$/, '');
const SOCKET_URL = (isProductionHost ? PRODUCTION_API : (configuredSocket || PRODUCTION_API)).replace(/\/$/, '');
let socket = null, token = localStorage.getItem('photocall_guest_token'), currentUser = null;
let guestId = localStorage.getItem('photocall_guest_id') || crypto.randomUUID();
localStorage.setItem('photocall_guest_id', guestId);
let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
let photos = [], selected = 0, img = null, mirrored = false;
let audioCtx, source, filter, compressor, shaper, analyser, destination, micStream, processedStream;
let voiceRecorder=null, voiceCloneQueueTime=0, voiceCloneBusy=false, uploadedVoiceReady=false;
let pc = null, joined = false, muted = false, voiceMode = 'normal', audioLevel = 0;
let timerStart = 0, timerHandle = null, callId = null, outgoingStream = null;

async function api(path, options={}) {
  const headers = {'Content-Type':'application/json', ...(options.headers||{})};
  if(token) headers.Authorization=`Bearer ${token}`;
  const r=await fetch(API+path,{...options,headers});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.message||`Request failed (${r.status})`);
  return data;
}
function setAuthView(logged){ $('#app').classList.toggle('hidden',!logged); $('#userBadge').classList.toggle('hidden',!logged); if(logged) $('#userBadge').textContent=currentUser?.name || 'Guest'; }
function authMessage(t){console.warn(t||'');} function say(t){$('#msg').textContent=t;}
async function loadSavedAvatar(){
  try{
    const r=await fetch(API+'/api/profile/avatar',{headers:{Authorization:'Bearer '+token}});
    if(!r.ok)return;
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    photos.forEach(p=>{if(p.persisted&&p.url)URL.revokeObjectURL(p.url)});
    photos=[{url,name:'Saved avatar',persisted:true}];
    selected=0;
    galleryRender();
    loadPhoto();
  }catch(e){console.warn('Saved avatar unavailable',e)}
}
async function ensureGuestSession(){
  if(token && currentUser) return currentUser;
  const d=await api('/api/session/guest',{method:'POST',body:JSON.stringify({guestId})});
  token=d.token; currentUser=d.user;
  localStorage.setItem('photocall_guest_token',token);
  localStorage.setItem('photocall_guest_id',d.guestId||guestId);
  return currentUser;
}
async function boot(){
  try{
    await ensureGuestSession();
    const cfg=await api('/api/config');
    iceServers=cfg.iceServers||iceServers;
    avatarEnabledEl.checked=currentUser.avatarEnabled!==false;
    voiceEnabledEl.checked=!!currentUser.voiceEnabled;
    uploadedVoiceReady=!!currentUser.voiceReady;
    voiceStatusEl.textContent=uploadedVoiceReady?'Uploaded voice ready.':'No uploaded voice selected.';
    setAuthView(true);
    await loadSavedAvatar();
    connectSocket();
    say('PhotoCall is ready. Upload your photo to begin.');
  }catch(e){
    console.error(e);
    setAuthView(true);
    say(e.message||'PhotoCall could not start. Check the backend configuration.');
  }
}

const avatarEnabledEl=$('#avatarEnabled'), voiceEnabledEl=$('#voiceEnabled'), voiceFileEl=$('#voiceFile'), voiceStatusEl=$('#voiceStatus');
async function savePreferences(){try{const d=await api('/api/profile/preferences',{method:'PATCH',body:JSON.stringify({avatarEnabled:avatarEnabledEl.checked,voiceEnabled:voiceEnabledEl.checked})});currentUser=d.user;uploadedVoiceReady=!!d.user.voiceReady;voiceStatusEl.textContent=d.user.voiceReady?'Uploaded voice ready.':'No uploaded voice selected.';}catch(e){voiceStatusEl.textContent=e.message}}
avatarEnabledEl.onchange=savePreferences; voiceEnabledEl.onchange=async()=>{if(voiceEnabledEl.checked&&!uploadedVoiceReady){voiceEnabledEl.checked=false;return voiceStatusEl.textContent='Upload and validate a voice first.';} await savePreferences();};
voiceFileEl.onchange=async()=>{const f=voiceFileEl.files?.[0];if(!f)return;if(f.size>12*1024*1024)return voiceStatusEl.textContent='Voice sample must be 12MB or smaller.';if(!f.type.startsWith('audio/'))return voiceStatusEl.textContent='Choose an audio file.';voiceStatusEl.textContent='Uploading and validating voice…';try{const form=new FormData();form.append('file',f,f.name);const r=await fetch(API+'/api/voice/clone',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Voice cloning failed.');uploadedVoiceReady=!!d.ready;if(uploadedVoiceReady){voiceEnabledEl.checked=true;await savePreferences();voiceStatusEl.textContent='Voice validated and enabled.';}else{voiceStatusEl.textContent='Voice submitted. Provider verification is still required.';}}catch(e){voiceStatusEl.textContent=e.message}};
const canvas=$('#avatar'),ctx=canvas.getContext('2d'),files=$('#photos'),gallery=$('#gallery'),remote=$('#remote'),hint=$('#hint'),talking=$('#talking'),meterBar=$('#meterBar'),photoValidation=$('#photoValidation');
function galleryRender(){gallery.innerHTML='';photos.forEach((p,i)=>{const b=document.createElement('button');b.className=`thumb ${i===selected?'active':''}`;const im=document.createElement('img');im.src=p.url;im.alt=`Avatar ${i+1}`;b.append(im);b.onclick=()=>{selected=i;mirrored=false;loadPhoto();galleryRender()};gallery.append(b)});}
function loadPhoto(){if(!photos.length){img=null;hint.classList.remove('hidden');$('#photoInfo').textContent='No photo selected';photoValidation.textContent='Photo check: waiting for an image.';return}hint.classList.add('hidden');$('#photoInfo').textContent=`${selected+1} / ${photos.length} selected`;img=new Image();img.onload=async()=>{drawAvatar();const valid=await validateHumanPhoto(img);const photo=photos[selected];if(valid&&photo.file&&!photo.persisted&&!photo.uploading){photo.uploading=true;photoValidation.textContent='Human face detected. Saving avatar…';try{const form=new FormData();form.append('file',photo.file,photo.file.name);const r=await fetch(API+'/api/profile/avatar',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Avatar upload failed.');photo.persisted=true;photo.uploading=false;photoValidation.textContent='Photo saved. Ready for live avatar calling.';}catch(e){photo.uploading=false;photoValidation.textContent=e.message||'Avatar could not be saved.'}}};img.src=photos[selected].url;}
let humanDetector=null;
async function validateHumanPhoto(image){
  photoValidation.textContent='Photo check: analyzing for a human face…';
  try{
    if(window.Human?.Human){
      if(!humanDetector){
        humanDetector=new Human.Human({
          backend:'webgl',
          modelBasePath:'https://cdn.jsdelivr.net/npm/@vladmandic/human/models/',
          face:{enabled:true,detector:{rotation:false,return:true},mesh:{enabled:false},iris:{enabled:false},description:{enabled:false},emotion:{enabled:false},antispoof:{enabled:false},liveness:{enabled:false}},
          body:{enabled:false},hand:{enabled:false},object:{enabled:false},gesture:{enabled:false},segmentation:{enabled:false},
          debug:false
        });
        await humanDetector.load();
        await humanDetector.warmup();
      }
      const result=await humanDetector.detect(image);
      const faces=Array.isArray(result.face)?result.face:[];
      if(faces.length>0){photoValidation.textContent=`Photo check: human face detected. Ready for live avatar calling.`;return true;}
      photoValidation.textContent='Photo check: no human face detected. Upload a clear photo showing a person’s face.';return false;
    }
    if('FaceDetector' in window){
      const detector=new FaceDetector({fastMode:true,maxDetectedFaces:5});
      const faces=await detector.detect(image);
      if(faces.length>0){photoValidation.textContent=`Photo check: ${faces.length} human face${faces.length===1?'':'s'} detected.`;return true;}
      photoValidation.textContent='Photo check: no face detected. Upload a clear human face photo.';return false;
    }
  }catch(e){console.warn('Human face detection unavailable',e)}
  photoValidation.textContent='Photo check: image loaded. Browser face detection is unavailable, so use a clear front-facing human photo.';
  return true;
}
files.onchange=e=>{[...e.target.files].filter(f=>/^image\/(jpeg|png|webp)$/.test(f.type)).forEach(f=>photos.push({url:URL.createObjectURL(f),name:f.name,file:f,persisted:false}));selected=Math.max(0,photos.length-1);galleryRender();loadPhoto();say(`${photos.length} photo${photos.length===1?'':'s'} ready.`)};
$('#flip').onclick=()=>{mirrored=!mirrored;drawAvatar()};$('#reset').onclick=async()=>{mirrored=false;try{await api('/api/profile/avatar',{method:'DELETE'});}catch(e){console.warn('Avatar delete failed',e)}photos.forEach(p=>{if(p.url)URL.revokeObjectURL(p.url)});photos=[];selected=0;loadPhoto();galleryRender();say('Avatar reset.');};
function drawCover(image){const cw=canvas.width,ch=canvas.height,s=Math.max(cw/image.width,ch/image.height),w=image.width*s,h=image.height*s;ctx.save();ctx.translate(cw/2,ch/2);ctx.scale(mirrored?-1:1,1);ctx.drawImage(image,-w/2,-h/2,w,h);ctx.restore()}
function drawAvatar(){ctx.fillStyle='#070b15';ctx.fillRect(0,0,canvas.width,canvas.height);if(!img)return;drawCover(img);const l=audioLevel,mouth=4+l*30,cx=canvas.width*.5,cy=canvas.height*.69;ctx.save();ctx.globalAlpha=Math.min(.72,.25+l*.45);ctx.fillStyle='#160b14';ctx.beginPath();ctx.ellipse(cx,cy,38+l*5,mouth,0,0,Math.PI*2);ctx.fill();ctx.globalAlpha=.75;ctx.strokeStyle='#f2b6b6';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(cx-28,cy);ctx.quadraticCurveTo(cx,cy+l*8,cx+28,cy);ctx.stroke();ctx.restore();}
function animation(){if(analyser){const a=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(a);let sum=0;for(const v of a){const n=(v-128)/128;sum+=n*n}audioLevel+=(Math.min(1,Math.sqrt(sum/a.length)*5)-audioLevel)*.25}else audioLevel*=.9;meterBar.style.width=`${Math.round(audioLevel*100)}%`;talking.classList.toggle('hidden',!img||audioLevel<.035);drawAvatar();requestAnimationFrame(animation)} animation();
function robotCurve(){const n=65536,c=new Float32Array(n);for(let i=0;i<n;i++){const x=i*2/n-1;c[i]=Math.tanh(3*x)}return c}
async function setupAudio(){if(!micStream)return;if(audioCtx)await audioCtx.close().catch(()=>{});audioCtx=new(window.AudioContext||window.webkitAudioContext)();source=audioCtx.createMediaStreamSource(micStream);filter=audioCtx.createBiquadFilter();filter.type='peaking';compressor=audioCtx.createDynamicsCompressor();compressor.threshold.value=-24;compressor.knee.value=20;compressor.ratio.value=8;compressor.attack.value=.003;compressor.release.value=.25;shaper=audioCtx.createWaveShaper();shaper.oversample='4x';analyser=audioCtx.createAnalyser();analyser.fftSize=256;destination=audioCtx.createMediaStreamDestination();source.connect(filter).connect(compressor).connect(shaper).connect(analyser);applyVoice();processedStream=destination.stream; if(voiceEnabledEl.checked&&uploadedVoiceReady) startVoiceClonePipeline(); else shaper.connect(destination);}
async function startVoiceClonePipeline(){if(!micStream||voiceRecorder)return;voiceCloneQueueTime=audioCtx.currentTime+0.05;const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus': 'audio/webm';try{voiceRecorder=new MediaRecorder(micStream,{mimeType:mime});voiceRecorder.ondataavailable=async e=>{if(!e.data.size)return;try{voiceCloneBusy=true;const form=new FormData();form.append('file',e.data,'speech.webm');const r=await fetch(API+'/api/voice/convert',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).message||'Voice conversion failed');const buf=await audioCtx.decodeAudioData(await r.arrayBuffer());const node=audioCtx.createBufferSource();node.buffer=buf;node.connect(destination);const when=Math.max(audioCtx.currentTime+0.02,voiceCloneQueueTime);node.start(when);voiceCloneQueueTime=when+buf.duration;}catch(err){console.warn(err);voiceStatusEl.textContent='Uploaded voice conversion temporarily failed; retrying…'}finally{voiceCloneBusy=false}};voiceRecorder.start(2800);}catch(e){voiceStatusEl.textContent='Voice conversion is unavailable in this browser.';shaper.connect(destination)}}
function stopVoiceClonePipeline(){try{voiceRecorder?.stop()}catch{}voiceRecorder=null;voiceCloneQueueTime=0;}
function applyVoice(){if(!filter||!shaper)return;const m={normal:[900,0,1],deep:[480,-7,.85],bright:[2600,7,1.2],robot:[1200,2,1]};const [f,g,q]=m[voiceMode];filter.frequency.value=f;filter.gain.value=g;filter.Q.value=q;shaper.curve=voiceMode==='robot'?robotCurve():null;}
document.querySelectorAll('.voice').forEach(b=>b.onclick=()=>{voiceMode=b.dataset.voice;document.querySelectorAll('.voice').forEach(x=>x.classList.toggle('active',x===b));applyVoice();say(`Voice effect: ${b.querySelector('b').textContent}.`)});
async function startMic(){if(micStream)return;micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});await setupAudio();$('#mic').textContent='⏹ Stop microphone';$('#mute').disabled=false;say('Microphone ready.');}
$('#mic').onclick=async()=>{try{if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;processedStream=null;if(audioCtx)await audioCtx.close().catch(()=>{});audioCtx=null;$('#mic').textContent='🎙 Start microphone';$('#mute').disabled=true;muted=false;$('#mute').textContent='🔇 Mute';say('Microphone stopped.')}else await startMic()}catch(e){say(`Microphone error: ${e.message}`)}};
$('#mute').onclick=()=>{if(!micStream)return;muted=!muted;micStream.getAudioTracks().forEach(t=>t.enabled=!muted);$('#mute').textContent=muted?'🎙 Unmute':'🔇 Mute'};
function makePeer(){pc=new RTCPeerConnection({iceServers});pc.onicecandidate=e=>e.candidate&&socket.emit('ice-candidate',{room:$('#room').value.trim(),candidate:e.candidate});pc.ontrack=e=>{remote.srcObject=e.streams[0];$('#remoteState').textContent='Connected — live avatar + processed voice';startTimer();remote.play().catch(()=>{})};pc.onconnectionstatechange=()=>{if(!pc)return;$('#remoteState').textContent=`Connection: ${pc.connectionState}`;if(['failed','closed'].includes(pc.connectionState)&&joined)cleanup(false)};pc.oniceconnectionstatechange=()=>{if(pc?.iceConnectionState==='failed')say('WebRTC ICE failed. Check the Metered TURN configuration and network.');};return pc;}
async function outgoing(){if(avatarEnabledEl.checked&&!img)throw new Error('Upload a human photo first or turn off Use human avatar.');if(photoValidation.textContent.includes('no human face')||photoValidation.textContent.includes('no face detected'))throw new Error('Please upload a clear human face photo before starting the call.');if(!micStream)await startMic();const vs=avatarEnabledEl.checked?canvas.captureStream(30):new MediaStream(),ats=processedStream?.getAudioTracks()||[];if(!ats.length)throw new Error('Processed microphone audio is unavailable.');return new MediaStream([...vs.getVideoTracks(),...ats]);}
$('#call').onclick=async()=>{try{if(!socket)throw new Error('PhotoCall signaling is not connected yet.');const room=$('#room').value.trim();if(!room)throw new Error('Enter a room code.');outgoingStream=await outgoing();makePeer();outgoingStream.getTracks().forEach(t=>pc.addTrack(t,outgoingStream));const d=await api('/api/calls',{method:'POST',body:JSON.stringify({room})});callId=d.id;socket.emit('join-room',room);joined=true;$('#call').disabled=true;$('#hang').disabled=false;$('#room').disabled=true;$('#remoteState').textContent='Waiting for your partner…';}catch(e){say(e.message)}};
function inviteText(){const url=new URL('/receiver.html?room='+encodeURIComponent($('#room').value.trim()),window.location.href).href;return `Join my PhotoCall call: ${url}\nRoom: ${$('#room').value.trim()}`;}
document.querySelector('#connectSignal')?.addEventListener('click',()=>{if(window.PhotoCallAndroid?.connectSignal){window.PhotoCallAndroid.connectSignal();say('Signal opened. Keep the PhotoCall avatar session active while making the Signal call.');}else{say('Signal connection is available from the PhotoCall Android app.');}});
$('#shareSignal').onclick=async()=>{const text=inviteText();try{if(window.PhotoCallAndroid?.shareToSignal){window.PhotoCallAndroid.shareToSignal(text);say('Signal share opened. Keep PhotoCall available while you complete the Signal call.');return;}if(navigator.share){await navigator.share({title:'PhotoCall call',text});say('Share opened. Choose Signal to send the PhotoCall invite.');}else{await navigator.clipboard.writeText(text);say('PhotoCall invite copied. Open Signal and paste it into your chat.');}}catch(e){if(e.name!=='AbortError')say('Unable to open sharing. The invite was not sent.');}};
function startTimer(){timerStart=Date.now();clearInterval(timerHandle);timerHandle=setInterval(()=>{const s=Math.floor((Date.now()-timerStart)/1000);$('#callTimer').textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`},500)}
function stopTimer(){clearInterval(timerHandle);timerHandle=null;$('#callTimer').textContent='00:00'}
async function cleanup(emit=true){if(emit&&joined)socket?.emit('call-ended',$('#room').value.trim());if(callId)api(`/api/calls/${callId}/end`,{method:'PATCH'}).catch(()=>{});pc?.close();pc=null;stopVoiceClonePipeline();outgoingStream?.getTracks().forEach(t=>t.stop());outgoingStream=null;joined=false;callId=null;remote.srcObject=null;$('#call').disabled=false;$('#hang').disabled=true;$('#room').disabled=false;$('#remoteState').textContent='Waiting for connection…';stopTimer()}
$('#hang').onclick=()=>cleanup(true);$('#copyRoom').onclick=async()=>{try{await navigator.clipboard.writeText($('#room').value.trim());say('Copy room code copied.')}catch{say('Copy failed — select the room code manually.')}};
boot();

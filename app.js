/*
 * Närvaro is intentionally serverless for media. A short-lived Cloudflare
 * Pages Function exchanges the SDP handshake; audio and video travel directly
 * between the two WebRTC peers.
 */
const state = {
  role: 'parent',
  mode: 'monitor',
  video: false,
  thresholdEnabled: false,
  threshold: 58,
  peer: null,
  channel: null,
  localStream: null,
  audioContext: null,
  analyser: null,
  levelData: null,
  levelTimer: null,
  offerReady: false,
  connected: false,
  roomCode: null,
  roomPollTimer: null,
  localMuted: false,
  remoteMuted: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  createOffer: $('#create-offer'),
  inviteOutput: $('#invite-output'),
  inviteWords: $('#invite-words'),
  inviteExpires: $('#invite-expires'),
  inviteQr: $('#invite-qr'),
  inviteLink: $('#invite-link'),
  shareInvite: $('#share-invite'),
  copyInviteLink: $('#copy-invite-link'),
  inviteInput: $('#invite-input'),
  joinInvite: $('#join-invite'),
  offerOutput: $('#offer-output'),
  offerCode: $('#offer-code'),
  incomingCode: $('#incoming-code'),
  processCode: $('#process-code'),
  answerOutput: $('#answer-output'),
  answerCode: $('#answer-code'),
  connectionMessage: $('#connection-message'),
  connectionLabel: $('#connection-label'),
  remoteName: $('#remote-name'),
  previewStatus: $('#preview-status'),
  previewStage: $('#preview-stage'),
  previewPlaceholder: $('#preview-placeholder'),
  localVideo: $('#local-video'),
  remoteVideo: $('#remote-video'),
  remoteAudio: $('#remote-audio'),
  videoOverlay: $('#video-overlay'),
  muteLocalButton: $('#mute-local-button'),
  muteRemoteButton: $('#mute-remote-button'),
  disconnectButton: $('#disconnect-button'),
  fullscreenButton: $('#fullscreen-button'),
  videoToggle: $('#video-toggle'),
  thresholdToggle: $('#threshold-toggle'),
  thresholdSlider: $('#threshold-slider'),
  thresholdValue: $('#threshold-value'),
  thresholdMarker: $('#threshold-marker'),
  levelFill: $('#level-fill'),
  levelValue: $('#level-value'),
  childFilterNote: $('#child-filter-note'),
  answerStepCopy: $('#answer-step-copy'),
  audioControlCard: $('#audio-control-card'),
};

const rtcConfig = {
  // STUN only helps the peers discover a direct route. No media is sent here.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function setMessage(message, type = '') {
  els.connectionMessage.textContent = message;
  els.connectionMessage.className = `inline-message${type ? ` is-${type}` : ''}`;
}

function setConnectionStatus(status, copy = 'Koppla ihop två enheter för att börja') {
  els.connectionLabel.textContent = status;
  els.previewStatus.textContent = copy;
  const connected = status === 'Ansluten';
  els.connectionLabel.previousElementSibling.classList.toggle('is-connected', connected);
}

function encodeSignal(description) {
  const json = JSON.stringify(description);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function decodeSignal(value) {
  const binary = atob(value.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function normalizeInviteCode(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let candidate = input;
  try {
    if (/^https?:\/\//i.test(input)) {
      candidate = new URL(input).searchParams.get('invite') || '';
    }
  } catch {
    return '';
  }
  const words = candidate.toLowerCase().replace(/[^a-zåäö0-9\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  if (words.length !== 4 || words.some((word) => word.length < 2 || word.length > 24)) return '';
  return words.join('-');
}

function getInviteLink(code = state.roomCode) {
  if (!code) return '';
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('invite', code);
  return url.toString();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  document.execCommand('copy');
  helper.remove();
}

function renderInvite(code, expiresAt) {
  state.roomCode = code;
  els.inviteWords.textContent = code.split('-').join(' · ');
  els.inviteLink.value = getInviteLink(code);
  if (expiresAt) {
    els.inviteExpires.textContent = `Gäller till ${new Date(expiresAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}`;
  }
  els.inviteOutput.classList.remove('is-hidden');
  if (window.QRCode?.toCanvas) {
    window.QRCode.toCanvas(els.inviteQr, els.inviteLink.value, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#173d35', light: '#ffffff' },
    }, () => {});
  }
}

async function requestRoom(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* The local static server may return an HTML 404. */ }
  if (!response.ok) {
    throw new Error(payload.error || `Signaling svarade med ${response.status}.`);
  }
  return payload;
}

async function createRoom(offer) {
  return requestRoom('/api/room', {
    method: 'POST',
    body: JSON.stringify({
      offer,
      role: state.role,
      mode: state.mode,
      video: state.video,
    }),
  });
}

async function pollForAnswer(code) {
  window.clearInterval(state.roomPollTimer);
  const poll = async () => {
    if (!state.peer || state.peer.connectionState === 'closed' || state.peer.currentRemoteDescription) return;
    try {
      const room = await requestRoom(`/api/room?code=${encodeURIComponent(code)}`);
      if (room.answer) {
        await state.peer.setRemoteDescription(room.answer);
        window.clearInterval(state.roomPollTimer);
        setMessage('Svar mottaget. Försöker koppla ihop enheterna…');
      }
    } catch (error) {
      window.clearInterval(state.roomPollTimer);
      setMessage(error.message || 'Kunde inte läsa invite-svaret.', 'error');
    }
  };
  await poll();
  if (state.peer && !state.peer.currentRemoteDescription) {
    state.roomPollTimer = window.setInterval(poll, 1500);
  }
}

async function joinRoom() {
  const code = normalizeInviteCode(els.inviteInput.value);
  if (!code) {
    setMessage('Skriv in fyra invite-ord eller klistra in delningslänken.', 'error');
    return;
  }
  try {
    els.joinInvite.disabled = true;
    setMessage('Läser invite och startar din enhet…');
    const room = await requestRoom(`/api/room?code=${encodeURIComponent(code)}`);
    if (!room.offer) throw new Error('Inviten saknar en aktiv anslutning. Skapa en ny invite.');
    const stream = await ensureLocalMedia();
    state.peer?.close();
    state.peer = new RTCPeerConnection(rtcConfig);
    setupPeerEvents(state.peer);
    state.peer.addEventListener('datachannel', (event) => setupChannel(event.channel));
    await state.peer.setRemoteDescription(room.offer);
    await attachLocalTracks(state.peer, stream);
    const answer = await state.peer.createAnswer();
    await state.peer.setLocalDescription(answer);
    await waitForIceComplete(state.peer);
    await requestRoom(`/api/room?code=${encodeURIComponent(code)}`, {
      method: 'PATCH',
      body: JSON.stringify({ answer: state.peer.localDescription }),
    });
    state.roomCode = code;
    setMessage('Svar skickat. Försöker koppla ihop enheterna…', 'success');
    els.answerStepCopy.textContent = 'Svar skickat automatiskt. Väntar på direkt anslutning.';
  } catch (error) {
    setMessage(mediaErrorMessage(error), 'error');
  } finally {
    els.joinInvite.disabled = false;
  }
}

async function shareInvite() {
  if (!state.roomCode) return;
  const url = getInviteLink();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Närvaro invite', text: 'Öppna den här länken för att koppla upp Närvaro.', url });
      setMessage('Invite-länken är delad.', 'success');
    } else {
      await copyText(url);
      setMessage('Delningslänken är kopierad.', 'success');
    }
  } catch (error) {
    if (error.name !== 'AbortError') setMessage('Kunde inte dela länken.', 'error');
  }
}

async function copyInviteLink() {
  if (!state.roomCode) return;
  try {
    await copyText(getInviteLink());
    const original = els.copyInviteLink.innerHTML;
    els.copyInviteLink.innerHTML = 'Kopierad ✓';
    window.setTimeout(() => { els.copyInviteLink.innerHTML = original; }, 1400);
  } catch {
    setMessage('Kunde inte kopiera länken.', 'error');
  }
}

function waitForIceComplete(peer, timeout = 2500) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const handleChange = () => {
      if (peer.iceGatheringState === 'complete') {
        peer.removeEventListener('icegatheringstatechange', handleChange);
        resolve();
      }
    };
    peer.addEventListener('icegatheringstatechange', handleChange);
    setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', handleChange);
      resolve();
    }, timeout);
  });
}

function releaseLocalMedia() {
  if (state.levelTimer) window.clearInterval(state.levelTimer);
  state.levelTimer = null;
  state.analyser = null;
  state.levelData = null;
  if (state.audioContext) state.audioContext.close().catch(() => {});
  state.audioContext = null;
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  els.localVideo.srcObject = null;
  els.localVideo.classList.add('is-hidden');
  updateSessionControls();
}

function applyLocalAudioState(level = getCurrentLevel()) {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  const thresholdAllowsAudio = state.role !== 'child' || !state.thresholdEnabled || level >= state.threshold;
  track.enabled = !state.localMuted && thresholdAllowsAudio;
}

function updateSessionControls() {
  els.muteLocalButton.disabled = !state.localStream;
  els.muteRemoteButton.disabled = !els.remoteAudio.srcObject;
  els.disconnectButton.disabled = !(state.peer || state.localStream || state.roomCode);
  els.muteLocalButton.textContent = state.localMuted ? 'Mikrofon av' : 'Muta mikrofon';
  els.muteLocalButton.setAttribute('aria-pressed', String(state.localMuted));
  els.muteRemoteButton.textContent = state.remoteMuted ? 'Sätt på ljud' : 'Tysta ljud';
  els.muteRemoteButton.setAttribute('aria-pressed', String(state.remoteMuted));
}

function mediaErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Mikrofon/kamera nekades. Tillåt åtkomst för narvaro.londogard.com och försök igen.';
  }
  if (error?.name === 'NotFoundError') return 'Ingen mikrofon eller kamera hittades på enheten.';
  if (error?.name === 'NotReadableError') return 'Mikrofonen eller kameran används redan av en annan app.';
  return error?.message || 'Kunde inte starta mikrofon eller kamera.';
}

async function attachLocalTracks(peer, stream, includeVideoSlot = false) {
  let audioTransceiver = peer.getTransceivers().find((transceiver) => transceiver.receiver.track.kind === 'audio');
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack && audioTransceiver) {
    await audioTransceiver.sender.replaceTrack(audioTrack);
    if (audioTransceiver.direction !== 'sendrecv') audioTransceiver.direction = 'sendrecv';
  } else if (audioTrack) {
    peer.addTrack(audioTrack, stream);
  }

  let videoTransceiver = peer.getTransceivers().find((transceiver) => transceiver.receiver.track.kind === 'video');
  if (includeVideoSlot && !videoTransceiver) {
    // Always negotiate a video slot in the offer. This lets the answerer send
    // video even when the offerer has its own camera turned off.
    videoTransceiver = peer.addTransceiver('video', { direction: 'sendrecv' });
  }
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack && videoTransceiver) {
    await videoTransceiver.sender.replaceTrack(videoTrack);
    if (videoTransceiver.direction !== 'sendrecv') videoTransceiver.direction = 'sendrecv';
  } else if (videoTrack) {
    peer.addTrack(videoTrack, stream);
  }
}

async function ensureLocalMedia() {
  const currentHasVideo = Boolean(state.localStream?.getVideoTracks().length);
  if (state.localStream && currentHasVideo === state.video) return state.localStream;
  if (state.localStream) releaseLocalMedia();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Den här webbläsaren kan inte använda mikrofon eller kamera.');
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: state.video ? { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' } : false,
  });
  setupAnalyser();
  if (state.audioContext?.state === 'suspended') state.audioContext.resume().catch(() => {});
  applyLocalAudioState();
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (videoTrack) {
    els.localVideo.srcObject = state.localStream;
    els.localVideo.classList.remove('is-hidden');
    els.previewPlaceholder.classList.add('is-hidden');
    els.localVideo.play().catch(() => {});
    videoTrack.addEventListener('ended', () => {
      els.localVideo.classList.add('is-hidden');
      if (!els.remoteVideo.srcObject) els.previewPlaceholder.classList.remove('is-hidden');
      setMessage('Kameran stängdes av. Kontrollera kamerabehörigheten och försök igen.', 'error');
    }, { once: true });
  }
  updateSessionControls();
  return state.localStream;
}

function setupAnalyser() {
  if (!state.localStream?.getAudioTracks().length || state.audioContext) return;
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioContext.createMediaStreamSource(state.localStream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  state.levelData = new Uint8Array(state.analyser.fftSize);
  source.connect(state.analyser);
  state.levelTimer = window.setInterval(updateAudioMeter, 120);
}

function getCurrentLevel() {
  if (!state.analyser || !state.levelData) return 0;
  state.analyser.getByteTimeDomainData(state.levelData);
  let sum = 0;
  state.levelData.forEach((value) => {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  });
  const rms = Math.sqrt(sum / state.levelData.length);
  const db = 20 * Math.log10(Math.max(rms, 0.0001));
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

function thresholdToDb(value) {
  return Math.round(-60 + (value / 100) * 60);
}

function updateAudioMeter() {
  const level = getCurrentLevel();
  const thresholdPosition = state.threshold;
  els.levelFill.style.width = `${Math.max(3, level)}%`;
  els.thresholdMarker.style.left = `${thresholdPosition}%`;
  els.levelValue.textContent = state.localStream ? `${thresholdToDb(level)} dB` : '— dB';
  if (state.role === 'child' && state.localStream) {
    // With the policy off, the child mic should immediately return to open.
    applyLocalAudioState(level);
  }
}

function updateThresholdUI() {
  state.threshold = Number(els.thresholdSlider.value);
  els.thresholdValue.textContent = `${thresholdToDb(state.threshold)} dB`;
  els.thresholdMarker.style.left = `${state.threshold}%`;
  els.thresholdToggle.checked = state.thresholdEnabled;
  const disabled = state.role !== 'parent';
  els.audioControlCard.classList.toggle('is-child-view', disabled);
  els.thresholdSlider.disabled = disabled;
  els.thresholdToggle.disabled = disabled;
  els.childFilterNote.classList.toggle('is-hidden', state.role !== 'child' || !state.thresholdEnabled);
  if (state.role === 'child') {
    els.audioControlCard.querySelector('.card-lede').textContent = 'Parent-enheten kan styra när din mikrofon öppnas.';
  } else {
    els.audioControlCard.querySelector('.card-lede').textContent = 'Skicka bara ljud från child-enheten när rummet blir högljutt.';
  }
}

function sendControl(payload) {
  if (state.channel?.readyState === 'open') state.channel.send(JSON.stringify(payload));
}

function sendRoleAndSettings() {
  sendControl({ type: 'hello', role: state.role, mode: state.mode, video: state.video });
  if (state.role === 'parent') {
    sendControl({ type: 'audio-policy', enabled: state.thresholdEnabled, threshold: state.threshold });
  }
}

function handleControlMessage(message) {
  if (message.type === 'hello') {
    els.remoteName.textContent = message.role === 'parent' ? 'Parent-enhet' : 'Child-enhet';
    if (message.role === 'child' && state.role === 'parent') {
      setMessage('Child-enheten är redo. Ljudfilter skickas nu.', 'success');
      sendControl({ type: 'audio-policy', enabled: state.thresholdEnabled, threshold: state.threshold });
    }
  }
  if (message.type === 'audio-policy' && state.role === 'child') {
    state.thresholdEnabled = Boolean(message.enabled);
    state.threshold = Number(message.threshold ?? state.threshold);
    els.thresholdSlider.value = state.threshold;
    updateThresholdUI();
  }
}

function setupChannel(channel) {
  state.channel = channel;
  channel.addEventListener('open', () => {
    sendRoleAndSettings();
    setMessage('Anslutningen är krypterad och direkt.', 'success');
  });
  channel.addEventListener('message', (event) => {
    try { handleControlMessage(JSON.parse(event.data)); } catch { /* Ignore malformed control messages. */ }
  });
}

function setupPeerEvents(peer) {
  peer.addEventListener('connectionstatechange', () => {
    const connectionState = peer.connectionState;
    if (connectionState === 'connected') {
      state.connected = true;
      setConnectionStatus('Ansluten', 'Ljudlinjen är öppen');
      updateSessionControls();
    } else if (['failed', 'disconnected', 'closed'].includes(connectionState)) {
      state.connected = false;
      setConnectionStatus('Frånkopplad', 'Försök skapa en ny inbjudan');
      setMessage('Anslutningen bröts. Du kan prova igen.', 'error');
      updateSessionControls();
    }
  });
  peer.addEventListener('track', (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    if (event.track.kind === 'video') {
      els.remoteVideo.srcObject = stream;
      els.remoteVideo.classList.remove('is-hidden');
      els.previewPlaceholder.classList.add('is-hidden');
      els.videoOverlay.classList.remove('is-hidden');
      els.remoteVideo.play().catch(() => {});
    } else {
      els.remoteAudio.srcObject = stream;
      els.remoteAudio.muted = state.remoteMuted;
      els.remoteAudio.play().catch(() => {});
      els.previewPlaceholder.classList.add('is-hidden');
    }
    updateSessionControls();
  });
}

function disconnectSession(showMessage = true) {
  window.clearInterval(state.roomPollTimer);
  state.roomPollTimer = null;
  state.peer?.close();
  state.peer = null;
  state.channel = null;
  state.offerReady = false;
  state.connected = false;
  state.roomCode = null;
  state.localMuted = false;
  state.remoteMuted = false;
  releaseLocalMedia();
  els.remoteAudio.srcObject = null;
  els.remoteAudio.muted = false;
  els.remoteVideo.srcObject = null;
  els.remoteVideo.classList.add('is-hidden');
  els.videoOverlay.classList.add('is-hidden');
  els.previewPlaceholder.classList.remove('is-hidden');
  els.inviteOutput.classList.add('is-hidden');
  els.remoteName.textContent = 'Väntar på en vän';
  setConnectionStatus('Inte ansluten');
  updateSessionControls();
  if (showMessage) setMessage('Sessionen är avslutad. Du kan skapa en ny invite.', 'success');
}

function toggleLocalMute() {
  if (!state.localStream) return;
  state.localMuted = !state.localMuted;
  applyLocalAudioState();
  updateSessionControls();
  setMessage(state.localMuted ? 'Din mikrofon är mutad.' : 'Din mikrofon är på igen.', 'success');
}

function toggleRemoteMute() {
  if (!els.remoteAudio.srcObject) return;
  state.remoteMuted = !state.remoteMuted;
  els.remoteAudio.muted = state.remoteMuted;
  updateSessionControls();
  setMessage(state.remoteMuted ? 'Mottagningsljudet är tystat.' : 'Mottagningsljudet är på igen.', 'success');
}

async function createOffer() {
  try {
    els.createOffer.disabled = true;
    if (state.peer || state.localStream || state.roomCode) disconnectSession(false);
    setMessage('Förbereder mikrofon och skapar en säker inbjudan…');
    const stream = await ensureLocalMedia();
    state.peer?.close();
    state.peer = new RTCPeerConnection(rtcConfig);
    setupPeerEvents(state.peer);
    await attachLocalTracks(state.peer, stream, true);
    setupChannel(state.peer.createDataChannel('control'));
    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    await waitForIceComplete(state.peer);
    els.offerCode.value = encodeSignal(state.peer.localDescription);
    els.offerOutput.classList.remove('is-hidden');
    state.offerReady = true;
    els.createOffer.textContent = 'Ny inbjudan ↗';
    try {
      const room = await createRoom(state.peer.localDescription);
      renderInvite(room.code, room.expiresAt);
      await pollForAnswer(room.code);
      setMessage('Din invite är klar. Dela länken eller QR-koden med enhet B.', 'success');
    } catch (error) {
      // Keep the manual SDP fallback useful when the Pages Function/KV binding
      // has not been deployed yet.
      setMessage(`Kort invite kunde inte skapas ännu: ${error.message} Använd den avancerade manuella koden tills Cloudflare är klar.`, 'error');
    }
  } catch (error) {
    setMessage(mediaErrorMessage(error), 'error');
  } finally {
    els.createOffer.disabled = false;
  }
}

async function processIncomingCode() {
  const raw = els.incomingCode.value.trim();
  if (!raw) {
    setMessage('Klistra in en inbjudnings- eller svarskod först.', 'error');
    return;
  }
  try {
    els.processCode.disabled = true;
    if (normalizeInviteCode(raw)) {
      els.inviteInput.value = raw;
      await joinRoom();
      return;
    }
    const signal = decodeSignal(raw);
    if (signal.type === 'offer') {
      setMessage('Inbjudan läst. Startar din enhet…');
      const stream = await ensureLocalMedia();
      state.peer?.close();
      state.peer = new RTCPeerConnection(rtcConfig);
      setupPeerEvents(state.peer);
      state.peer.addEventListener('datachannel', (event) => setupChannel(event.channel));
      await state.peer.setRemoteDescription(signal);
      await attachLocalTracks(state.peer, stream);
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      await waitForIceComplete(state.peer);
      els.answerCode.value = encodeSignal(state.peer.localDescription);
      els.answerOutput.classList.remove('is-hidden');
      els.answerStepCopy.textContent = 'Skicka nu svarskoden tillbaka till enhet A.';
      setMessage('Svarskoden är klar. Skicka tillbaka den till enhet A.', 'success');
      els.processCode.textContent = 'Skapa nytt svar →';
    } else if (signal.type === 'answer') {
      if (!state.peer || !state.offerReady) throw new Error('Skapa en inbjudan på den här enheten först.');
      await state.peer.setRemoteDescription(signal);
      setMessage('Svar mottaget. Försöker koppla ihop enheterna…');
    } else {
      throw new Error('Koden känns inte igen. Skapa en ny kod och försök igen.');
    }
  } catch (error) {
    setMessage(mediaErrorMessage(error), 'error');
  } finally {
    els.processCode.disabled = false;
  }
}

function changeRole(role) {
  state.role = role;
  $$('.segment').forEach((button) => button.classList.toggle('is-active', button.dataset.role === role));
  updateThresholdUI();
  if (state.connected) sendRoleAndSettings();
}

function changeMode(mode) {
  state.mode = mode;
  $$('.mode-button').forEach((button) => button.classList.toggle('is-active', button.dataset.mode === mode));
  if (state.connected) sendControl({ type: 'hello', role: state.role, mode, video: state.video });
}

function changeVideo(enabled) {
  if (state.connected) {
    els.videoToggle.checked = Boolean(state.localStream?.getVideoTracks().length);
    setMessage('Video ändras nästa gång du kopplar ihop enheterna.');
    return;
  }
  state.video = enabled;
  if (state.peer || state.localStream || state.roomCode) {
    disconnectSession(false);
  }
  if (enabled) {
    ensureLocalMedia()
      .then(() => setMessage('Kameran är aktiv. Skapa en invite när du är redo.', 'success'))
      .catch((error) => {
        state.video = false;
        els.videoToggle.checked = false;
        releaseLocalMedia();
        setMessage(mediaErrorMessage(error), 'error');
      });
  }
}

async function copyTarget(event) {
  const target = document.getElementById(event.currentTarget.dataset.copyTarget);
  try {
    await navigator.clipboard.writeText(target.value);
    const original = event.currentTarget.innerHTML;
    event.currentTarget.innerHTML = 'Kopierad ✓';
    setTimeout(() => { event.currentTarget.innerHTML = original; }, 1400);
  } catch {
    target.select();
    document.execCommand('copy');
  }
}

els.createOffer.addEventListener('click', createOffer);
els.processCode.addEventListener('click', processIncomingCode);
els.joinInvite.addEventListener('click', joinRoom);
els.shareInvite.addEventListener('click', shareInvite);
els.copyInviteLink.addEventListener('click', copyInviteLink);
els.muteLocalButton.addEventListener('click', toggleLocalMute);
els.muteRemoteButton.addEventListener('click', toggleRemoteMute);
els.disconnectButton.addEventListener('click', () => disconnectSession(true));
els.inviteInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinRoom();
});
els.videoToggle.addEventListener('change', (event) => changeVideo(event.target.checked));
els.thresholdToggle.addEventListener('change', (event) => {
  state.thresholdEnabled = event.target.checked;
  updateThresholdUI();
  sendControl({ type: 'audio-policy', enabled: state.thresholdEnabled, threshold: state.threshold });
});
els.thresholdSlider.addEventListener('input', () => {
  state.threshold = Number(els.thresholdSlider.value);
  updateThresholdUI();
  sendControl({ type: 'audio-policy', enabled: state.thresholdEnabled, threshold: state.threshold });
});
els.fullscreenButton.addEventListener('click', () => {
  if (els.previewStage.requestFullscreen) els.previewStage.requestFullscreen();
});
$$('.segment').forEach((button) => button.addEventListener('click', () => changeRole(button.dataset.role)));
$$('.mode-button').forEach((button) => button.addEventListener('click', () => changeMode(button.dataset.mode)));
$$('.copy-button[data-copy-target]').forEach((button) => button.addEventListener('click', copyTarget));

const inviteFromUrl = new URL(window.location.href).searchParams.get('invite');
if (inviteFromUrl && normalizeInviteCode(inviteFromUrl)) {
  els.inviteInput.value = inviteFromUrl;
  setMessage('Invite-länk hittad. Tryck på Anslut med invite när du vill starta.', 'success');
}

updateThresholdUI();
setConnectionStatus('Inte ansluten');
updateSessionControls();

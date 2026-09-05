/*
 * Närvaro is intentionally serverless for media. The two short-lived SDP
 * blobs are exchanged manually, while audio/video itself travels over WebRTC.
 */
const state = {
  role: 'parent',
  mode: 'monitor',
  video: false,
  thresholdEnabled: true,
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
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  createOffer: $('#create-offer'),
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
  remoteVideo: $('#remote-video'),
  remoteAudio: $('#remote-audio'),
  videoOverlay: $('#video-overlay'),
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

function waitForIceComplete(peer) {
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
    }, 8000);
  });
}

async function ensureLocalMedia() {
  if (state.localStream) return state.localStream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Den här webbläsaren kan inte använda mikrofon eller kamera.');
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: state.video ? { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' } : false,
  });
  setupAnalyser();
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
    const shouldSend = !state.thresholdEnabled || level >= state.threshold;
    const track = state.localStream.getAudioTracks()[0];
    if (track && track.enabled !== shouldSend) track.enabled = shouldSend;
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
    } else if (['failed', 'disconnected', 'closed'].includes(connectionState)) {
      state.connected = false;
      setConnectionStatus('Frånkopplad', 'Försök skapa en ny inbjudan');
      setMessage('Anslutningen bröts. Du kan prova igen.', 'error');
    }
  });
  peer.addEventListener('track', (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    if (event.track.kind === 'video') {
      els.remoteVideo.srcObject = stream;
      els.remoteVideo.classList.remove('is-hidden');
      els.previewPlaceholder.classList.add('is-hidden');
      els.videoOverlay.classList.remove('is-hidden');
    } else {
      els.remoteAudio.srcObject = stream;
      els.remoteAudio.play().catch(() => {});
      els.previewPlaceholder.classList.add('is-hidden');
    }
  });
}

async function createOffer() {
  try {
    els.createOffer.disabled = true;
    setMessage('Förbereder mikrofon och skapar en säker inbjudan…');
    const stream = await ensureLocalMedia();
    state.peer?.close();
    state.peer = new RTCPeerConnection(rtcConfig);
    setupPeerEvents(state.peer);
    stream.getTracks().forEach((track) => state.peer.addTrack(track, stream));
    setupChannel(state.peer.createDataChannel('control'));
    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    await waitForIceComplete(state.peer);
    els.offerCode.value = encodeSignal(state.peer.localDescription);
    els.offerOutput.classList.remove('is-hidden');
    state.offerReady = true;
    els.createOffer.textContent = 'Ny inbjudan ↗';
    setMessage('Koden är klar. Skicka den till enhet B.', 'success');
  } catch (error) {
    setMessage(error.message || 'Kunde inte skapa en inbjudan.', 'error');
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
    const signal = decodeSignal(raw);
    if (signal.type === 'offer') {
      setMessage('Inbjudan läst. Startar din enhet…');
      const stream = await ensureLocalMedia();
      state.peer?.close();
      state.peer = new RTCPeerConnection(rtcConfig);
      setupPeerEvents(state.peer);
      state.peer.addEventListener('datachannel', (event) => setupChannel(event.channel));
      stream.getTracks().forEach((track) => state.peer.addTrack(track, stream));
      await state.peer.setRemoteDescription(signal);
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
    setMessage(error.message || 'Kunde inte läsa koden.', 'error');
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
  state.video = enabled;
  if (!enabled && state.localStream) {
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.stop();
      state.localStream.removeTrack(videoTrack);
    }
  }
  if (state.connected) {
    setMessage('Video ändras nästa gång du kopplar ihop enheterna.');
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
$$('.copy-button').forEach((button) => button.addEventListener('click', copyTarget));

updateThresholdUI();
setConnectionStatus('Inte ansluten');

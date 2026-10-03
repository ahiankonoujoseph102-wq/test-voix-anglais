'use strict';

// ---------- Réglages ----------
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const SESSION_SECONDS = 5 * 60;
const WARN_AT = 4 * 60;        // « il reste une minute »
const CONCLUDE_AT = 4 * 60 + 30; // « conclus maintenant »
const VOICE = 'Puck';
const SPEECH_RMS = 0.02;       // seuil (approximatif) de détection de la voix de l'apprenant
// Tarifs payants relevés le 3 octobre 2026 pour gemini-3.8-live (USD / million de jetons),
// https://ai.google.dev/gemini-api/docs/pricing
const PRICE = { textIn: 0.75, audioIn: 3.0, videoIn: 1.0, textOut: 4.5, audioOut: 12.0 };

const SYSTEM_PROMPT = `Tu es Teacher Joe, un professeur d'anglais chaleureux et patient.
Ton élève est un francophone d'Afrique, grand débutant en anglais.

Règles :
- Explique en français simple, avec des mots courants. Phrases courtes.
- Fais répéter en anglais : propose un mot ou une phrase courte, demande à l'élève de la répéter, puis réagis.
- Corrige avec bienveillance : félicite d'abord, puis donne la bonne forme et fais répéter.
- Garde chaque réponse courte (2 ou 3 phrases maximum), puis laisse parler l'élève.
- Utilise des exemples de la vie quotidienne (marché, famille, école, salutations).
- Parle lentement et clairement quand tu dis une phrase en anglais.

Déroulement :
- La séance dure 5 minutes. Au début, présente-toi en une phrase et annonce que la séance dure 5 minutes.
- L'application t'enverra des notes entre crochets, par exemple [Note de l'application : ...].
  Ce ne sont pas des paroles de l'élève : suis-les sans les lire à voix haute.`;

// ---------- Éléments ----------
const $ = (id) => document.getElementById(id);
const el = {
  apiKey: $('apiKey'), model: $('model'), halfDuplex: $('halfDuplex'),
  startBtn: $('startBtn'), stopBtn: $('stopBtn'), copyBtn: $('copyBtn'), againBtn: $('againBtn'),
  setup: $('setup'), live: $('live'), results: $('results'),
  status: $('status'), timer: $('timer'), mouth: $('mouth'),
  micBar: $('micBar'), micState: $('micState'), subtitles: $('subtitles'),
  metrics: document.querySelector('#metrics tbody'), errors: $('errors'),
};

let S = null; // état de la séance en cours

function newState() {
  return {
    ws: null, ctx: null, stream: null, worklet: null, analyser: null, wakeLock: null,
    model: el.model.value,
    clickAt: performance.now(), setupAt: 0, endAt: 0,
    timerId: null, rafId: null, ended: false,
    nextPlay: 0, sources: new Set(),
    joeLine: null, learnerLine: null,
    // mesures
    audioSentSec: 0, audioRecvSec: 0,
    usageMsgs: 0, usageSum: { prompt: 0, response: 0, total: 0, byIn: {}, byOut: {} }, usageLast: null,
    promptPerTurn: [],
    joeTurns: 0, interruptions: 0, goAway: null,
    lastSpeechAt: 0, lastJoeEndAt: 0, joeSpeaking: false,
    pendingTrigger: null, // {type:'learner'|'note', at}
    latencies: [], noteLatencies: [],
    errors: [], warned: false, concluded: false,
    closeInfo: null,
  };
}

// ---------- Démarrage ----------
el.startBtn.addEventListener('click', start);
el.stopBtn.addEventListener('click', () => endSession('Arrêt manuel'));
el.againBtn.addEventListener('click', () => {
  el.results.hidden = true;
  el.setup.hidden = false;
});
el.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(S.report, null, 2));
    el.copyBtn.textContent = 'Copié !';
  } catch (e) {
    el.copyBtn.textContent = 'Copie impossible';
  }
  setTimeout(() => (el.copyBtn.textContent = 'Copier les mesures (JSON)'), 2000);
});

async function start() {
  const key = el.apiKey.value.trim();
  if (!key) { el.apiKey.focus(); return; }

  S = newState();
  el.setup.hidden = true;
  el.results.hidden = true;
  el.live.hidden = false;
  el.subtitles.textContent = '';
  el.timer.textContent = fmt(SESSION_SECONDS);
  setStatus('Connexion…');

  try {
    // Créé dans le geste de l'utilisateur pour que Chrome Android autorise le son.
    S.ctx = new AudioContext({ latencyHint: 'interactive' });
    await S.ctx.resume();

    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await S.ctx.audioWorklet.addModule('mic-worklet.js');

    // Sortie : sources -> analyseur (bouche) -> haut-parleur
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 512;
    S.analyser.connect(S.ctx.destination);

    try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { /* facultatif */ }
  } catch (e) {
    logError('Micro / audio : ' + e.message);
    endSession('Erreur au démarrage');
    return;
  }

  openSocket(key);
  animate();
}

function openSocket(key) {
  const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(key)}`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;

  ws.onopen = () => {
    setStatus('Configuration…');
    send({
      setup: {
        model: S.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      msg = JSON.parse(text);
    } catch (e) {
      logError('Message illisible : ' + e.message);
      return;
    }
    onMessage(msg);
  };
  ws.onerror = () => logError('Erreur WebSocket (réseau ou clé refusée)');
  ws.onclose = (ev) => {
    S.closeInfo = { code: ev.code, reason: ev.reason };
    if (!S.ended) {
      logError(`Connexion fermée par le serveur (code ${ev.code}${ev.reason ? ' : ' + ev.reason : ''})`);
      endSession('Connexion interrompue');
    }
  };
}

function send(obj) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
}

function sendNote(text) {
  S.pendingTrigger = { type: 'note', at: performance.now() };
  addLine('system', text);
  send({ realtimeInput: { text: `[Note de l'application : ${text}]` } });
}

// ---------- Messages du serveur ----------
function onMessage(msg) {
  if (msg.setupComplete) onSetupComplete();

  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) {
      S.interruptions++;
      stopPlayback();
      closeJoeTurn();
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data) playChunk(part.inlineData.data);
    }
    if (sc.outputTranscription?.text) appendJoe(sc.outputTranscription.text);
    if (sc.inputTranscription?.text) appendLearner(sc.inputTranscription.text);
    if (sc.turnComplete) closeJoeTurn();
  }

  if (msg.usageMetadata) recordUsage(msg.usageMetadata);
  if (msg.goAway) {
    S.goAway = msg.goAway.timeLeft || 'oui';
    logError('Le serveur annonce la fin de la connexion (goAway, temps restant : ' + S.goAway + ')');
  }
  if (msg.error) logError('Erreur API : ' + JSON.stringify(msg.error));
}

function onSetupComplete() {
  S.setupAt = performance.now();
  setStatus('En séance');
  startMic();
  S.timerId = setInterval(tick, 250);
  sendNote("La séance commence. Présente-toi et annonce qu'elle dure 5 minutes, puis commence la leçon.");
}

function tick() {
  const elapsed = (performance.now() - S.setupAt) / 1000;
  el.timer.textContent = fmt(Math.max(0, SESSION_SECONDS - elapsed));
  if (!S.warned && elapsed >= WARN_AT) {
    S.warned = true;
    sendNote("Il reste une minute. Préviens l'élève en une phrase, puis continue.");
  }
  if (!S.concluded && elapsed >= CONCLUDE_AT) {
    S.concluded = true;
    sendNote('Il reste 30 secondes. Conclus maintenant : résume en une ou deux phrases ce qui a été appris, encourage, et dis au revoir.');
  }
  if (elapsed >= SESSION_SECONDS) endSession('Fin des 5 minutes');
}

// ---------- Micro ----------
function startMic() {
  const src = S.ctx.createMediaStreamSource(S.stream);
  S.worklet = new AudioWorkletNode(S.ctx, 'mic-processor');
  src.connect(S.worklet);
  S.worklet.port.onmessage = (ev) => {
    if (S.ended) return;
    const { pcm, rms } = ev.data;
    const muted = el.halfDuplex.checked && joeAudible();
    el.micBar.style.width = muted ? '0%' : Math.min(100, rms * 400) + '%';
    el.micState.textContent = muted ? 'Micro : en pause (Teacher Joe parle)' : 'Micro : ouvert, parlez';
    if (muted) return;
    if (rms > SPEECH_RMS) {
      S.lastSpeechAt = performance.now();
      if (!S.joeSpeaking) S.pendingTrigger = { type: 'learner', at: S.lastSpeechAt };
    }
    S.audioSentSec += pcm.byteLength / 2 / 16000;
    send({ realtimeInput: { audio: { data: toBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
  };
}

function joeAudible() {
  // On laisse 0,4 s après la dernière syllabe pour éviter de capter la fin de la phrase.
  return S.ctx.currentTime < S.nextPlay + 0.4;
}

// ---------- Lecture de la voix ----------
function playChunk(b64) {
  const now = performance.now();
  if (!S.joeSpeaking) {
    S.joeSpeaking = true;
    S.joeTurns++;
    const t = S.pendingTrigger;
    if (t) {
      // Pour l'apprenant : du dernier son de sa voix au premier son de la réponse.
      const from = t.type === 'learner' ? S.lastSpeechAt : t.at;
      const ms = now - from;
      if (ms > 0 && ms < 30000) (t.type === 'learner' ? S.latencies : S.noteLatencies).push(ms);
      S.pendingTrigger = null;
    }
  }
  const bytes = fromBase64(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const buf = S.ctx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  S.audioRecvSec += buf.duration;

  const src = S.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(S.analyser);
  const t0 = Math.max(S.nextPlay, S.ctx.currentTime + 0.05);
  src.start(t0);
  S.nextPlay = t0 + buf.duration;
  S.sources.add(src);
  src.onended = () => S.sources.delete(src);
}

function stopPlayback() {
  for (const s of S.sources) { try { s.stop(); } catch (e) { /* déjà arrêtée */ } }
  S.sources.clear();
  S.nextPlay = 0;
}

function animate() {
  const data = new Uint8Array(S.analyser ? S.analyser.fftSize : 0);
  const loop = () => {
    if (!S || !S.analyser) return;
    S.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    const open = Math.min(1, rms * 6);
    el.mouth.setAttribute('ry', (2 + open * 22).toFixed(1));
    el.mouth.setAttribute('rx', (28 - open * 6).toFixed(1));
    S.rafId = requestAnimationFrame(loop);
  };
  loop();
}

// ---------- Sous-titres ----------
function addLine(cls, text) {
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  el.subtitles.appendChild(p);
  el.subtitles.scrollTop = el.subtitles.scrollHeight;
  return p;
}
function appendJoe(text) {
  S.learnerLine = null;
  if (!S.joeLine) S.joeLine = addLine('joe', '');
  S.joeLine.textContent += text;
  el.subtitles.scrollTop = el.subtitles.scrollHeight;
}
function appendLearner(text) {
  if (!S.learnerLine) S.learnerLine = addLine('learner', '');
  S.learnerLine.textContent += text;
  el.subtitles.scrollTop = el.subtitles.scrollHeight;
}
function closeJoeTurn() {
  S.joeLine = null;
  S.joeSpeaking = false;
}

// ---------- Jetons ----------
function recordUsage(u) {
  S.usageMsgs++;
  S.usageLast = u;
  S.usageSum.prompt += u.promptTokenCount || 0;
  S.usageSum.response += u.responseTokenCount || u.candidatesTokenCount || 0;
  S.usageSum.total += u.totalTokenCount || 0;
  if (u.promptTokenCount) S.promptPerTurn.push(u.promptTokenCount);
  addModalities(S.usageSum.byIn, u.promptTokensDetails);
  addModalities(S.usageSum.byOut, u.responseTokensDetails || u.candidatesTokensDetails);
}
function addModalities(target, details) {
  for (const d of details || []) target[d.modality] = (target[d.modality] || 0) + (d.tokenCount || 0);
}

function costUSD(byIn, byOut) {
  const m = 1e6;
  return ((byIn.TEXT || 0) * PRICE.textIn + (byIn.AUDIO || 0) * PRICE.audioIn +
          ((byIn.IMAGE || 0) + (byIn.VIDEO || 0)) * PRICE.videoIn +
          (byOut.TEXT || 0) * PRICE.textOut + (byOut.AUDIO || 0) * PRICE.audioOut) / m;
}

// ---------- Fin ----------
function endSession(reason) {
  if (!S || S.ended) return;
  S.ended = true;
  S.endAt = performance.now();
  clearInterval(S.timerId);
  if (S.ws && S.ws.readyState <= WebSocket.OPEN) S.ws.close(1000, 'fin de séance');
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  if (S.worklet) S.worklet.port.onmessage = null;
  try { S.wakeLock?.release(); } catch (e) { /* rien */ }
  setStatus('Séance terminée');

  // On laisse finir la phrase déjà reçue avant de couper le son.
  const remaining = S.ctx ? Math.max(0, S.nextPlay - S.ctx.currentTime) : 0;
  const ctx = S.ctx;
  const st = S;
  setTimeout(() => {
    cancelAnimationFrame(st.rafId);
    st.analyser = null;
    if (ctx && ctx.state !== 'closed') ctx.close();
  }, remaining * 1000 + 300);

  showResults(reason);
}

function showResults(reason) {
  const dur = S.setupAt ? (S.endAt - S.setupAt) / 1000 : 0;
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const u = S.usageSum;
  const estIn = Math.round(S.audioSentSec * 32);
  const estOut = Math.round(S.audioRecvSec * 32);
  const measuredCost = S.usageMsgs ? costUSD(u.byIn, u.byOut) : null;
  const estCost = (estIn * PRICE.audioIn + estOut * PRICE.audioOut) / 1e6;

  S.report = {
    date: new Date().toISOString(),
    modele: S.model,
    raison_fin: reason,
    duree_seance_s: +dur.toFixed(1),
    delai_connexion_ms: S.setupAt ? Math.round(S.setupAt - S.clickAt) : null,
    jetons_api: S.usageMsgs ? {
      messages_usage_recus: S.usageMsgs,
      somme_entree: u.prompt, somme_sortie: u.response, somme_total: u.total,
      entree_par_modalite: u.byIn, sortie_par_modalite: u.byOut,
      entree_par_tour: S.promptPerTurn,
      dernier_usageMetadata: S.usageLast,
    } : 'non fourni par l\'API',
    audio_envoye_s: +S.audioSentSec.toFixed(1),
    audio_recu_s: +S.audioRecvSec.toFixed(1),
    estimation_jetons_32_par_s: { entree: estIn, sortie: estOut },
    cout_usd_selon_jetons_api: measuredCost,
    cout_usd_selon_duree_audio: +estCost.toFixed(4),
    tours_teacher_joe: S.joeTurns,
    interruptions: S.interruptions,
    delai_reponse_apprenant_ms: { moyenne: avg(S.latencies), min: min(S.latencies), max: max(S.latencies), n: S.latencies.length, valeurs: S.latencies.map(Math.round) },
    delai_reponse_notes_ms: { moyenne: avg(S.noteLatencies), n: S.noteLatencies.length },
    fermeture: S.closeInfo,
    erreurs: S.errors,
    navigateur: navigator.userAgent,
  };

  const r = S.report;
  const rows = [
    ['Modèle', r.modele.replace('models/', '')],
    ['Fin de séance', r.raison_fin],
    ['Durée réelle', `${fmt(dur)} (${r.duree_seance_s} s)`],
    ['Délai de connexion', r.delai_connexion_ms != null ? `${r.delai_connexion_ms} ms` : '—'],
    ['Jetons en entrée (API)', S.usageMsgs ? `${u.prompt.toLocaleString('fr-FR')} ${fmtMod(u.byIn)}` : 'non fournis'],
    ['Jetons en sortie (API)', S.usageMsgs ? `${u.response.toLocaleString('fr-FR')} ${fmtMod(u.byOut)}` : 'non fournis'],
    ['Messages usageMetadata reçus', String(S.usageMsgs)],
    ['Jetons d\'entrée : premier / dernier tour', S.promptPerTurn.length ? `${S.promptPerTurn[0]} / ${S.promptPerTurn[S.promptPerTurn.length - 1]}` : '—'],
    ['Audio envoyé / reçu', `${r.audio_envoye_s} s / ${r.audio_recu_s} s`],
    ['Estimation (32 jetons/s)', `entrée ${estIn}, sortie ${estOut}`],
    ['Coût au tarif payant (jetons API)', measuredCost != null ? `${measuredCost.toFixed(4)} $` : '—'],
    ['Coût au tarif payant (durée audio)', `${estCost.toFixed(4)} $`],
    ['Délai moyen de réponse', r.delai_reponse_apprenant_ms.moyenne != null
      ? `${r.delai_reponse_apprenant_ms.moyenne} ms (min ${r.delai_reponse_apprenant_ms.min}, max ${r.delai_reponse_apprenant_ms.max}, ${r.delai_reponse_apprenant_ms.n} réponses)` : '—'],
    ['Délai moyen après une note de l\'app', r.delai_reponse_notes_ms.moyenne != null ? `${r.delai_reponse_notes_ms.moyenne} ms` : '—'],
    ['Tours de Teacher Joe / interruptions', `${S.joeTurns} / ${S.interruptions}`],
    ['Nombre d\'erreurs', String(S.errors.length)],
  ];
  el.metrics.textContent = '';
  for (const [k, v] of rows) {
    const tr = el.metrics.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  el.errors.textContent = '';
  if (!S.errors.length) {
    const li = document.createElement('li');
    li.textContent = 'Aucune';
    li.style.color = 'inherit';
    el.errors.appendChild(li);
  }
  for (const e of S.errors) {
    const li = document.createElement('li');
    li.textContent = `${e.t} s — ${e.msg}`;
    el.errors.appendChild(li);
  }

  el.live.hidden = true;
  el.results.hidden = false;
  el.setup.hidden = true;
}

// ---------- Utilitaires ----------
function logError(msg) {
  const t = S && S.setupAt ? ((performance.now() - S.setupAt) / 1000).toFixed(1) : '0.0';
  S.errors.push({ t, msg });
  console.warn(msg);
}
function setStatus(t) { el.status.textContent = t; }
function fmt(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtMod(by) {
  const parts = Object.entries(by).map(([k, v]) => `${k.toLowerCase()} ${v}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}
function min(a) { return a.length ? Math.round(Math.min(...a)) : null; }
function max(a) { return a.length ? Math.round(Math.max(...a)) : null; }
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

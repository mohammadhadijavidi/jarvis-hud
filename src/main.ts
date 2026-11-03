import './style.css';
import { NeuralCore } from './viz/core';
import { binSpectrum } from './viz/geometry';
import { Envelope } from './audio/level';
import { Mic } from './audio/mic';
import { Player } from './audio/player';
import { HudClient } from './net/client';
import { resolveWsUrl } from './net/url';
import { initialState, reduce, setConnection, type HudState } from './state/store';
import { Renderer, showToast } from './ui/render';
import type { AssistantState } from './protocol';

const url = resolveWsUrl(location, import.meta.env.VITE_JARVIS_WS_URL as string | undefined);
const renderer = new Renderer();
const core = new NeuralCore(document.getElementById('core') as HTMLCanvasElement);
const player = new Player();
const userEnv = new Envelope(0.6, 0.12);
const voiceEnv = new Envelope(0.55, 0.09);

let state: HudState = initialState();
let dirty = true;
let localListening = false;

const client = new HudClient(url, {
  onStatus(s) {
    state = setConnection(state, s);
    dirty = true;
  },
  onEvent(ev) {
    if (ev.type === 'audio') player.enqueue(ev.data, ev.sampleRate);
    if (ev.type === 'error') showToast(ev.message);
    if (ev.type === 'state' && ev.state === 'listening') player.flush();
    state = reduce(state, ev);
    dirty = true;
  },
});
client.connect();

// Microphone: streams PCM to speech-to-speech backends; otherwise uses the
// browser's speech recognition (where available) and sends text.
const mic = new Mic((b64) => client.send({ type: 'audio', data: b64, sampleRate: 24000 }));
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
};
const SR = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
  .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
let recog: Recognition | null = null;
const micBtn = document.getElementById('mic') as HTMLButtonElement;

async function toggleMic(): Promise<void> {
  if (mic.active) {
    mic.stop();
    recog?.stop();
    recog = null;
    localListening = false;
    if (state.meta?.accepts?.includes('audio')) client.send({ type: 'audio_commit' });
  } else {
    const streamAudio = !!state.meta?.accepts?.includes('audio');
    try {
      await mic.start(streamAudio);
    } catch (err) {
      showToast(`Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    localListening = true;
    if (!streamAudio) {
      if (!SR) {
        showToast('This browser has no speech recognition. The core still reacts to your voice; type to talk.');
      } else {
        recog = new SR();
        recog.continuous = true;
        recog.interimResults = false;
        recog.lang = navigator.language || 'en-US';
        recog.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i]!;
            if (r.isFinal && r[0].transcript.trim()) client.send({ type: 'user_text', text: r[0].transcript.trim() });
          }
        };
        recog.onend = () => {
          if (mic.active && recog) recog.start();
        };
        recog.start();
      }
    }
  }
  micBtn.setAttribute('aria-pressed', String(mic.active));
  micBtn.setAttribute('aria-label', mic.active ? 'Stop microphone' : 'Start microphone');
  dirty = true;
}
micBtn.addEventListener('click', () => void toggleMic());

const form = document.getElementById('console') as HTMLFormElement;
const input = document.getElementById('prompt') as HTMLInputElement;
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  if (!client.send({ type: 'user_text', text })) {
    showToast('Not connected to a backend. Start one with "npm run mock" and the HUD reconnects on its own.');
    return;
  }
  input.value = '';
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    player.flush();
    client.send({ type: 'interrupt' });
  }
});

// Session clock
const started = Date.now();
setInterval(() => {
  const s = Math.floor((Date.now() - started) / 1000);
  document.getElementById('t-clock')!.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

function visualState(): AssistantState {
  if (state.assistant !== 'idle') return state.assistant;
  if (player.playing) return 'speaking';
  return localListening ? 'listening' : 'idle';
}

function tick(): void {
  const u = userEnv.next(mic.active ? mic.level() : 0);
  const playerLevel = player.level();
  const v = voiceEnv.next(playerLevel || state.remoteLevel);
  const spec = player.spectrum() ?? (mic.active && state.assistant !== 'speaking' ? mic.spectrum() : null);
  core.inputs = {
    state: visualState(),
    userLevel: u,
    voiceLevel: v,
    spectrum: spec ? binSpectrum(spec, 60, Math.floor(spec.length * 0.6)) : undefined,
  };
  if (dirty) {
    renderer.render(state);
    if (localListening && state.assistant === 'idle') document.getElementById('state-word')!.textContent = 'Listening';
    document.getElementById('hud')!.dataset.state = visualState();
    dirty = false;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
core.start();

// Expose a tiny handle for automation (screenshots, e2e checks).
(window as unknown as { __jarvis: unknown }).__jarvis = {
  get state() {
    return state;
  },
  core,
};

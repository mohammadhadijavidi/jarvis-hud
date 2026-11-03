// A complete custom backend for Jarvis HUD in ~50 lines of plain Node.
// It speaks the HUD protocol directly, so you can see exactly what the HUD expects.
//
//   node examples/custom-backend.mjs            # listens on ws://127.0.0.1:8790
//   npm run dev  ->  open http://localhost:5173/?ws=ws://127.0.0.1:8790
//
// Responses are scripted (an echo bot), not produced by a model.
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8790);
const wss = new WebSocketServer({ port, host: '127.0.0.1' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

wss.on('connection', (ws) => {
  const send = (ev) => ws.send(JSON.stringify(ev));
  send({ type: 'meta', backend: 'Echo example', provider: 'none', model: 'echo', simulated: true, accepts: ['text'] });
  send({ type: 'state', state: 'idle' });
  let n = 0;

  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type !== 'user_text') return;
    const id = ++n;
    send({ type: 'transcript', id: `u${id}`, role: 'user', text: msg.text, final: true });
    send({ type: 'state', state: 'thinking' });

    // Show a tool card: count the words of the message.
    send({ type: 'tool_call', id: `t${id}`, name: 'word_count', args: { text: msg.text } });
    const words = msg.text.trim().split(/\s+/).length;
    await sleep(300);
    send({ type: 'tool_result', id: `t${id}`, status: 'ok', result: { words }, ms: 300 });

    // Stream the reply word by word with a voice level so the core animates.
    send({ type: 'state', state: 'speaking' });
    const reply = `You said ${words} words: ${msg.text}`;
    const parts = reply.split(' ');
    for (let i = 0; i < parts.length; i++) {
      send({ type: 'transcript', id: `a${id}`, role: 'assistant', text: (i ? ' ' : '') + parts[i], delta: i > 0 });
      send({ type: 'level', value: 0.3 + 0.6 * Math.abs(Math.sin(i * 1.7)) });
      await sleep(90);
    }
    send({ type: 'transcript', id: `a${id}`, role: 'assistant', text: '', delta: true, final: true });
    send({ type: 'level', value: 0 });
    send({ type: 'state', state: 'idle' });
  });
});

console.log(`Echo backend on ws://127.0.0.1:${port}  (open the HUD with ?ws=ws://127.0.0.1:${port})`);

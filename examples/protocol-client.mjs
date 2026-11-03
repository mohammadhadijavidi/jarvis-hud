// Headless client: connects to a running backend, sends prompts, and prints the
// HUD protocol events it receives. Useful for testing your own backend.
//
//   npm run mock                                  # in one terminal
//   node examples/protocol-client.mjs "what time is it in Dubai" "what is 12 * 7"
import WebSocket from 'ws';

const url = process.env.JARVIS_WS ?? 'ws://127.0.0.1:8787/ws';
const prompts = process.argv.slice(2);
if (!prompts.length) prompts.push('Run a quick system diagnostic');

const ws = new WebSocket(url);
let pending = [...prompts];
let answer = '';

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', client: 'protocol-client', protocol: 1 }));
  ws.send(JSON.stringify({ type: 'user_text', text: pending.shift() }));
});

ws.on('message', (raw) => {
  const ev = JSON.parse(String(raw));
  switch (ev.type) {
    case 'meta':
      console.log(`[meta] ${ev.backend} (${ev.provider}/${ev.model})${ev.simulated ? ' - simulated responses' : ''}`);
      break;
    case 'tool_call':
      console.log(`[tool] ${ev.name} ${JSON.stringify(ev.args)}`);
      break;
    case 'tool_result':
      console.log(`[tool] ${ev.status} in ${ev.ms} ms -> ${JSON.stringify(ev.result)}`);
      break;
    case 'transcript':
      if (ev.role === 'user') console.log(`\n> ${ev.text}`);
      else answer = ev.delta ? answer + ev.text : ev.text;
      break;
    case 'error':
      console.log(`[error] ${ev.message}`);
      break;
    case 'state':
      if (ev.state === 'idle' && answer) {
        console.log(`< ${answer}`);
        answer = '';
        const next = pending.shift();
        if (next) ws.send(JSON.stringify({ type: 'user_text', text: next }));
        else ws.close();
      }
      break;
  }
});
ws.on('error', (err) => {
  console.error(`Could not reach ${url}: ${err.message}. Start a backend with "npm run mock".`);
  process.exit(1);
});

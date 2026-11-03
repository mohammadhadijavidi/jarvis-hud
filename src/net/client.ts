/** Reconnecting WebSocket client speaking the HUD protocol. */
import { PROTOCOL_VERSION, parseServerEvent, type ClientEvent, type ServerEvent } from '../protocol';
import { backoffMs } from './url';

export interface ClientHandlers {
  onEvent(ev: ServerEvent): void;
  onStatus(status: 'connecting' | 'open' | 'closed'): void;
}

export class HudClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;

  constructor(
    private url: string,
    private h: ClientHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.h.onStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.h.onStatus('open');
      this.send({ type: 'hello', client: 'jarvis-hud', protocol: PROTOCOL_VERSION });
    };
    ws.onmessage = (m) => {
      const ev = parseServerEvent(typeof m.data === 'string' ? m.data : '');
      if (ev) this.h.onEvent(ev);
    };
    ws.onclose = () => {
      this.h.onStatus('closed');
      if (!this.closedByUser) this.retry();
    };
  }

  private retry(): void {
    setTimeout(() => this.connect(), backoffMs(this.attempt++));
  }

  send(ev: ClientEvent): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(ev));
    return true;
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}

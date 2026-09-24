// Broadcast relay for the testbed's `room` mode. Every text frame from one
// socket is forwarded verbatim to every OTHER socket; addressing
// (`{ from, to }`) is the page's business, not the relay's — the relay is a
// dumb channel, exactly like the Holochain remote-signal path the carriers
// really ride.
//
// Frames: JSON text, `{ from, to: string[] | null, kind: 'hello' | 'voice' |
// 'filmstrip', payload: string }`. `payload` is whatever the carrier handed
// `host.send`; the relay never parses it.
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8765);
const wss = new WebSocketServer({ port, host: process.env.HOST ?? '0.0.0.0' });

wss.on('connection', ws => {
  ws.on('message', data => {
    const text = data.toString();
    for (const c of wss.clients) {
      if (c !== ws && c.readyState === 1) c.send(text);
    }
  });
  ws.on('error', () => {});
});

// testbed.spec.ts waits for this exact prefix before opening pages; keep the
// format stable.
console.log(`relay on ws://0.0.0.0:${port}`);

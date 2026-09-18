import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';

const verifyToken = async (token: string) => {
  const match = /^token-(\w+)$/.exec(token);
  if (!match) {
    throw new Error('bad token');
  }
  return { uid: match[1]! };
};

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}

describe('sync WebSocket', () => {
  let app: App;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    app = buildApp({ dbPath: ':memory:', verifyToken });
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = app.fastify.server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('unexpected server address');
    }
    base = `127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
    await app.fastify.close();
  });

  const open = async (token: string, clientId: string) => {
    const socket = await connect(`ws://${base}/api/sync?token=${token}&clientId=${clientId}`);
    sockets.push(socket);
    return socket;
  };

  it('fans out item events to the same user, skipping the originating client', async () => {
    const phone = await open('token-alice', 'phone');
    const laptop = await open('token-alice', 'laptop');
    const bob = await open('token-bob', 'bobs-device');

    const phoneEvent = nextMessage(phone);
    let laptopGotMessage = false;
    laptop.once('message', () => {
      laptopGotMessage = true;
    });
    let bobGotMessage = false;
    bob.once('message', () => {
      bobGotMessage = true;
    });

    const res = await fetch(`http://${base}/api/items/i1`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer token-alice',
        'content-type': 'application/json',
        'x-client-id': 'laptop',
      },
      body: JSON.stringify({ blob: 'xcv1:ciphertext' }),
    });
    expect(res.status).toBe(204);

    const event = (await phoneEvent) as { type: string; item: { id: string; blob: string } };
    expect(event.type).toBe('item-added');
    expect(event.item.id).toBe('i1');
    expect(event.item.blob).toBe('xcv1:ciphertext');

    // Give any stray frames a moment to arrive before asserting silence.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(laptopGotMessage).toBe(false);
    expect(bobGotMessage).toBe(false);
  });

  it('rejects connections with a bad token', async () => {
    const socket = new WebSocket(`ws://${base}/api/sync?token=garbage`);
    const closeCode = await new Promise<number>((resolve) => {
      socket.on('close', (code) => resolve(code));
      socket.on('error', () => {});
    });
    expect(closeCode).toBe(4401);
  });
});

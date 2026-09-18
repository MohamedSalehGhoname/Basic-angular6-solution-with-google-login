import type { WebSocket } from 'ws';

export type SyncEvent =
  | { type: 'vault-updated' }
  | { type: 'item-added'; item: { id: string; blob: string; createdAt: number } }
  | { type: 'item-removed'; id: string }
  | { type: 'items-cleared' };

interface Connection {
  socket: WebSocket;
  clientId: string | null;
}

/**
 * Fan-out of change events to a user's connected devices. `exceptClientId`
 * skips the connection that caused the change, so devices don't echo their
 * own writes back to themselves.
 */
export class SyncHub {
  private readonly connections = new Map<string, Set<Connection>>();

  add(uid: string, socket: WebSocket, clientId: string | null): void {
    let set = this.connections.get(uid);
    if (!set) {
      set = new Set();
      this.connections.set(uid, set);
    }
    const connection: Connection = { socket, clientId };
    set.add(connection);
    socket.on('close', () => {
      set.delete(connection);
      if (set.size === 0) {
        this.connections.delete(uid);
      }
    });
  }

  broadcast(uid: string, event: SyncEvent, exceptClientId: string | null = null): void {
    const set = this.connections.get(uid);
    if (!set) {
      return;
    }
    const message = JSON.stringify(event);
    for (const connection of set) {
      if (exceptClientId !== null && connection.clientId === exceptClientId) {
        continue;
      }
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(message);
      }
    }
  }

  connectionCount(uid: string): number {
    return this.connections.get(uid)?.size ?? 0;
  }
}

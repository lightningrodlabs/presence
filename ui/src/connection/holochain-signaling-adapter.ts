/**
 * HolochainSignalingAdapter — Bridges Holochain RoomClient signaling
 * with the SignalingAdapter interface used by ConnectionManager.
 *
 * Sends: calls roomClient.sendMessage([agent], 'Sdp', payload)
 * Receives: dispatchSignal() is called by StreamsStore when 'Sdp' messages arrive
 */

import { AgentPubKey, AgentPubKeyB64, decodeHashFromBase64, encodeHashToBase64 } from '@holochain/client';
import { RoomClient } from '../room/room-client';
import type { SignalingAdapter, SignalMessage, Unsubscribe } from './types';

export class HolochainSignalingAdapter implements SignalingAdapter {
  private _roomClient: RoomClient;
  private _messageType: string;
  private _handlers: ((from: string, message: SignalMessage) => void)[] = [];

  constructor(roomClient: RoomClient, messageType: string = 'Sdp') {
    this._roomClient = roomClient;
    this._messageType = messageType;
  }

  sendSignal(to: AgentPubKeyB64, message: SignalMessage): void {
    const agentPubKey = decodeHashFromBase64(to);
    const payload = JSON.stringify({
      connection_id: message.connectionId,
      type: message.type,
      data: message.data,
    });
    this._roomClient.sendMessage([agentPubKey], this._messageType, payload).catch(e => {
      console.error('Failed to send signal:', e);
    });
  }

  onSignal(handler: (from: string, message: SignalMessage) => void): Unsubscribe {
    this._handlers.push(handler);
    return () => {
      this._handlers = this._handlers.filter(h => h !== handler);
    };
  }

  /**
   * Called by StreamsStore when a signal of the matching message type arrives from Holochain.
   * Parses the payload and dispatches to registered handlers.
   */
  dispatchSignal(fromAgent: AgentPubKey, payload: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      console.error('Failed to parse Sdp signal payload:', e);
      return;
    }

    const fromB64 = encodeHashToBase64(fromAgent);
    const message: SignalMessage = {
      type: parsed.type,
      connectionId: parsed.connection_id,
      data: parsed.data,
    };

    for (const handler of this._handlers) {
      try {
        handler(fromB64, message);
      } catch (e) {
        console.error('Signal handler error:', e);
      }
    }
  }
}

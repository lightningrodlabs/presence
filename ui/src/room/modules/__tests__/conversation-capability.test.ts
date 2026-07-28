import { describe, it, expect } from 'vitest';
import {
  conversationPayloadSupportsFsm,
  DEFAULT_CONVERSATION_PAYLOAD,
} from '../conversation';
import type { ModuleStateEnvelope } from '../types';

function envelope(payload: unknown, active = true): ModuleStateEnvelope {
  return {
    moduleId: 'conversation',
    active,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    updatedAt: 0,
  };
}

/**
 * The payload shapes below are the ones the released builds actually emit.
 * `webrtcImpl`, `fsmWith` and `peerImpl` all entered the payload in the
 * commit that put `SdpFsm` on the wire (2d20e93); `git grep -E
 * 'webrtcImpl|fsmWith|peerImpl'` over v0.14.0..v0.14.7 finds nothing, and
 * those releases contain no `SdpFsm` handler. That is why the presence of
 * any one of them is a sound capability marker.
 */
describe('conversationPayloadSupportsFsm — release payload shapes', () => {
  it('a v0.14.7-and-earlier payload is not FSM-capable', () => {
    const preFsm = {
      micMuted: true,
      webrtcDisabled: false,
      disableWebrtcWith: [],
    };
    expect(conversationPayloadSupportsFsm(envelope(preFsm))).toBe(false);
  });

  it('a payload carrying webrtcImpl is FSM-capable', () => {
    expect(
      conversationPayloadSupportsFsm(envelope(DEFAULT_CONVERSATION_PAYLOAD)),
    ).toBe(true);
  });

  it('webrtcImpl: "simplepeer" is still capable — it is a preference, not a capability', () => {
    // A modern peer that prefers SimplePeer can still parse SdpFsm. Reading
    // its preference as incapacity would pin every such link to SimplePeer
    // forever, which is the opposite error.
    expect(
      conversationPayloadSupportsFsm(
        envelope({ ...DEFAULT_CONVERSATION_PAYLOAD, webrtcImpl: 'simplepeer' }),
      ),
    ).toBe(true);
  });

  it('the pre-Phase-3 fsmWith encoding is FSM-capable', () => {
    expect(
      conversationPayloadSupportsFsm(
        envelope({ micMuted: true, webrtcDisabled: false, fsmWith: [] }),
      ),
    ).toBe(true);
  });

  it('a peerImpl-only payload is FSM-capable', () => {
    expect(
      conversationPayloadSupportsFsm(
        envelope({ micMuted: true, peerImpl: {} }),
      ),
    ).toBe(true);
  });
});

describe('conversationPayloadSupportsFsm — the conservative direction', () => {
  it('treats a missing envelope as not capable', () => {
    expect(conversationPayloadSupportsFsm(null)).toBe(false);
  });

  it('treats an unparseable payload as not capable', () => {
    expect(conversationPayloadSupportsFsm(envelope('{not json'))).toBe(false);
  });

  it('treats an empty payload as not capable', () => {
    expect(conversationPayloadSupportsFsm(envelope('{}'))).toBe(false);
  });

  it('reads capability from an INACTIVE module too', () => {
    // Capability is a property of the peer's build, not of whether they
    // currently have the conversation module switched on.
    // `parseConversationPayload` returns null for an inactive envelope,
    // which would otherwise read as "not capable" and silently pin the link
    // to SimplePeer.
    expect(
      conversationPayloadSupportsFsm(
        envelope(DEFAULT_CONVERSATION_PAYLOAD, false),
      ),
    ).toBe(true);
  });
});

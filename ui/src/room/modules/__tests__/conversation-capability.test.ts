import { describe, it, expect } from 'vitest';
import {
  conversationPayloadCaps,
  conversationPayloadSupportsFsm,
  parseConversationPayload,
  DEFAULT_CONVERSATION_PAYLOAD,
} from '../conversation';
import { CAP_SDP_FSM, WIRE_CAPS } from '../../../transport/wire-contract';
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

describe('conversationPayloadCaps — declared capability (Phase 1.5 item 3)', () => {
  it('a caps array is taken verbatim', () => {
    expect(
      conversationPayloadCaps(envelope(DEFAULT_CONVERSATION_PAYLOAD)),
    ).toEqual(new Set(WIRE_CAPS));
  });

  it('an EMPTY caps array is a declaration of baseline-only — it outranks the field probe', () => {
    // webrtcImpl is present, so the legacy probe would say fsm-capable;
    // the explicit declaration wins.
    const env = envelope({ ...DEFAULT_CONVERSATION_PAYLOAD, caps: [] });
    expect(conversationPayloadSupportsFsm(env)).toBe(true);
    expect(conversationPayloadCaps(env).has(CAP_SDP_FSM)).toBe(false);
  });

  it('unknown capability strings are carried, not dropped — forward compatible', () => {
    const env = envelope({
      ...DEFAULT_CONVERSATION_PAYLOAD,
      caps: ['sdp-fsm', 'some-future-cap'],
    });
    expect(conversationPayloadCaps(env)).toEqual(
      new Set(['sdp-fsm', 'some-future-cap']),
    );
  });

  it('non-string entries in caps are dropped', () => {
    const env = envelope({ caps: ['sdp-fsm', 42, null, {}] });
    expect(conversationPayloadCaps(env)).toEqual(new Set(['sdp-fsm']));
  });

  it('no declaration falls back to the field probe: 0.14.8 shape ⇒ sdp-fsm', () => {
    const v0148 = {
      micMuted: true,
      webrtcDisabled: false,
      disableWebrtcWith: [],
      webrtcImpl: 'fsm',
      peerImpl: {},
    };
    expect(conversationPayloadCaps(envelope(v0148))).toEqual(
      new Set([CAP_SDP_FSM]),
    );
  });

  it('no declaration falls back to the field probe: 0.14.7 shape ⇒ baseline only', () => {
    const v0147 = {
      micMuted: true,
      webrtcDisabled: false,
      disableWebrtcWith: [],
    };
    expect(conversationPayloadCaps(envelope(v0147))).toEqual(new Set());
  });

  it('missing envelope and unparseable payload mean baseline only', () => {
    expect(conversationPayloadCaps(null)).toEqual(new Set());
    expect(conversationPayloadCaps(envelope('{not json'))).toEqual(new Set());
  });

  it('reads capability from an INACTIVE module, like the probe it wraps', () => {
    expect(
      conversationPayloadCaps(
        envelope(DEFAULT_CONVERSATION_PAYLOAD, false),
      ).has(CAP_SDP_FSM),
    ).toBe(true);
  });
});

describe('parseConversationPayload — caps round-trip on the self-write path', () => {
  it('a caps-less legacy payload re-parses to THIS build\'s caps, not []', () => {
    // Every payload write site round-trips parse(existing) before
    // re-stringifying. If a caps-less payload parsed to caps: [], our own
    // next write would emit an explicit baseline-only declaration and
    // silently downgrade all our links. See the parse note in
    // conversation.ts.
    const legacy = envelope({
      micMuted: true,
      webrtcDisabled: false,
      disableWebrtcWith: [],
      webrtcImpl: 'fsm',
      peerImpl: {},
    });
    expect(parseConversationPayload(legacy)?.caps).toEqual([...WIRE_CAPS]);
  });

  it('a declared caps array survives the round-trip verbatim', () => {
    const declared = envelope({
      ...DEFAULT_CONVERSATION_PAYLOAD,
      caps: ['sdp-fsm', 'some-future-cap'],
    });
    expect(parseConversationPayload(declared)?.caps).toEqual([
      'sdp-fsm',
      'some-future-cap',
    ]);
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

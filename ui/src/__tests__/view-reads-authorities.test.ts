import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Round 3 item 5 — view paint reads authorities, not private re-parses.
 * These are source pins in the no-ambient-clock.test.ts style: they
 * mechanize the item's grep exit-criterion so re-inlining a parse is a
 * failing test, not a review catch.
 *
 * The authorities: `parseConversationPayload` /
 * `StreamsStore.webrtcDisabled` for the conversation payload,
 * `decideFlowGlyph` (carrier-stats-policy.ts) for the stats panel's
 * tx/rx glyph.
 */

const src = (rel: string) =>
  readFileSync(join(__dirname, '..', rel), 'utf8');

describe('no conversation-payload re-parse outside conversation.ts', () => {
  // Files that render per-peer conversation state. `JSON.parse` of a
  // conversation envelope's payload is the shape both item-5 bugs took;
  // the conversation module itself is the one legitimate parser.
  const VIEW_FILES = [
    'room/room-view.ts',
    'room/elements/peer-stats-panel.ts',
    'room/elements/audio-level-meter.ts',
  ];

  it.each(VIEW_FILES)('%s does not JSON.parse a conversation payload', file => {
    const text = src(file);
    // The literal shapes the two fixed sites used: parsing a variable
    // holding a conversation envelope's payload. Any JSON.parse within
    // a few lines of a ['conversation'] read is the re-inline signature.
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes("['conversation']")) return;
      const windowText = lines.slice(i, i + 8).join('\n');
      expect(
        windowText.includes('JSON.parse'),
        `${file}:${i + 1} parses the conversation payload inline — route it through parseConversationPayload / a store predicate`,
      ).toBe(false);
    });
  });

  it('room-view reads the carrier-disable answer from the store authority', () => {
    const text = src('room/room-view.ts');
    expect(text).toContain('this.streamsStore.webrtcDisabled(');
    expect(text).toContain('parseConversationPayload(');
  });
});

describe('the stats panel flow glyph comes from the policy', () => {
  it('peer-stats-panel calls decideFlowGlyph and carries no inline carrier-arm branching', () => {
    const text = src('room/elements/peer-stats-panel.ts');
    expect(text).toContain('decideFlowGlyph(');
    // The re-inline signature of the old WebRTC arm: reading flow off
    // raw slot fields in the panel.
    expect(text).not.toMatch(/rx = !!conn/);
    expect(text).not.toMatch(/tx = !!conn/);
  });
});

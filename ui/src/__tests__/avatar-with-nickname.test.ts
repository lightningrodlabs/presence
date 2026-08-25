// @vitest-environment jsdom
/**
 * <avatar-with-nickname> render pin: a profile with a nickname but no
 * avatar image must still show the nickname (identicon in place of the
 * image), and the hideAvatar/hideNickname flags must apply to that
 * branch the same way they apply to the image branch.
 *
 * Field symptom (2026-08-25): a peer who set a nickname but no avatar
 * showed only the identicon — renderProfile early-returned the bare
 * identicon whenever fields.avatar was absent, dropping the nickname
 * and ignoring hideAvatar.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'lit';

// holo-identicon paints to a canvas in updated(); jsdom has no canvas.
// The mock keeps the tag unregistered so lit renders it as an inert
// unknown element we can assert on by tag name.
vi.mock('../shared/holo-identicon', () => ({}));

import { AvatarWithNickname } from '../room/elements/avatar-with-nickname';

const AGENT = new Uint8Array(39).fill(7);

function renderedProfile(
  opts: { avatar?: string; hideAvatar?: boolean; hideNickname?: boolean } = {}
): HTMLElement {
  const el = new AvatarWithNickname();
  el.agentPubKey = AGENT;
  el.hideAvatar = opts.hideAvatar ?? false;
  el.hideNickname = opts.hideNickname ?? false;
  const profile = {
    entry: { nickname: 'Alice', fields: opts.avatar ? { avatar: opts.avatar } : {} },
  } as any;
  const container = document.createElement('div');
  render(el.renderProfile(profile), container);
  return container;
}

function visible(node: Element | null): boolean {
  if (!node) return false;
  // Both branches hide via inline display:none; jsdom resolves inline
  // styles without layout, so this is exact, not a heuristic.
  let cur: Element | null = node;
  while (cur) {
    if ((cur as HTMLElement).style?.display === 'none') return false;
    cur = cur.parentElement;
  }
  return true;
}

describe('avatar-with-nickname renderProfile', () => {
  it('profile with avatar renders image and nickname', () => {
    const c = renderedProfile({ avatar: 'data:image/png;base64,xyz' });
    expect(visible(c.querySelector('img'))).toBe(true);
    expect(c.textContent).toContain('Alice');
  });

  it('profile without avatar renders identicon AND nickname', () => {
    const c = renderedProfile();
    expect(visible(c.querySelector('holo-identicon'))).toBe(true);
    expect(c.textContent).toContain('Alice');
    const span = c.querySelector('span');
    expect(visible(span)).toBe(true);
  });

  it('hideAvatar hides the identicon fallback but keeps the nickname', () => {
    const c = renderedProfile({ hideAvatar: true });
    expect(visible(c.querySelector('holo-identicon'))).toBe(false);
    expect(visible(c.querySelector('span'))).toBe(true);
    expect(c.textContent).toContain('Alice');
  });

  it('hideNickname keeps the identicon fallback and hides the nickname', () => {
    const c = renderedProfile({ hideNickname: true });
    expect(visible(c.querySelector('holo-identicon'))).toBe(true);
    expect(visible(c.querySelector('span'))).toBe(false);
  });

  it('missing profile still renders the bare identicon', () => {
    const el = new AvatarWithNickname();
    el.agentPubKey = AGENT;
    const container = document.createElement('div');
    render(el.renderProfile(undefined), container);
    expect(container.querySelector('holo-identicon')).toBeTruthy();
  });
});

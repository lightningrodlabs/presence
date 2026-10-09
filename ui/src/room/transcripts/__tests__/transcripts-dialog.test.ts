// @vitest-environment jsdom
/**
 * The transcripts dialog's modal behavior: it opens in the top layer
 * (`showModal`), Escape goes back from a transcript and closes from the
 * list, a backdrop click closes, and its panel is left-aligned whatever the page
 * around it does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MemoryTranscriptStore } from '../store';
import { TranscriptsDialog } from '../transcripts-dialog';

// jsdom may not implement the modal half of <dialog>; the stub records the
// call and sets `open`, which is all the element reads.
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
});

async function mount(): Promise<{ el: TranscriptsDialog; dialog: HTMLDialogElement; closed: ReturnType<typeof vi.fn> }> {
  const el = document.createElement('transcripts-dialog') as TranscriptsDialog;
  el.store = new MemoryTranscriptStore();
  el.roomKey = 'room';
  const closed = vi.fn();
  el.addEventListener('transcripts-close', closed);
  document.body.appendChild(el);
  await el.updateComplete;
  const dialog = el.shadowRoot!.querySelector('dialog') as HTMLDialogElement;
  return { el, dialog, closed };
}

describe('transcripts-dialog', () => {
  beforeEach(() => {
    showModal.mockClear();
    HTMLDialogElement.prototype.showModal = showModal;
    document.body.innerHTML = '';
  });

  it('opens as a modal dialog, not a positioned overlay', async () => {
    const { dialog } = await mount();
    expect(dialog).not.toBeNull();
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.instances[0]).toBe(dialog);
  });

  it('closes when the dialog closes (Escape)', async () => {
    const { dialog, closed } = await mount();
    expect(closed).not.toHaveBeenCalled();
    dialog.dispatchEvent(new Event('close'));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('Escape on an open transcript goes back to the list instead of closing', async () => {
    const { el, dialog, closed } = await mount();
    (el as any)._viewing = { id: 'room:1', roomKey: 'room', roomName: '', startedAt: 1, frames: [], labels: {} };
    await el.updateComplete;
    expect(dialog.querySelector('transcript-view')).not.toBeNull();

    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    await el.updateComplete;
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.querySelector('transcript-view')).toBeNull();
    expect(closed).not.toHaveBeenCalled();

    // From the list, Escape is left to the dialog, which closes.
    const second = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it('closes on a backdrop click and not on a click inside the panel', async () => {
    const { dialog, closed } = await mount();
    dialog.querySelector('.panel')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).not.toHaveBeenCalled();
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('left-aligns the panel and takes no fixed position of its own', () => {
    const css = (TranscriptsDialog.styles as { cssText: string }).cssText;
    const panel = css.slice(css.indexOf('.panel {'), css.indexOf('}', css.indexOf('.panel {')));
    expect(panel).toMatch(/text-align:\s*left/);
    expect(css).not.toMatch(/position:\s*fixed/);
  });
});

// Copied from presence ui/src/room/modules/voice.ts at ab90584 (signals-media extraction). Presence keeps its own copy until the adoption round.

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  // chunk to avoid stack overflow on large inputs (Opus frames are ~200B so
  // unnecessary, but keeps this safe).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK))
    );
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

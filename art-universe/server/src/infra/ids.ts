import crypto from 'node:crypto';

/** Internal, never exposed. */
export const internalId = (): string => crypto.randomUUID();

/**
 * Public artwork reference used in /art/7K3P9X.
 * Crockford-ish alphabet: no vowels (avoids accidental words), no 0/O/1/I/L.
 */
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export const publicRef = (length = 6): string => {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i++) {
    const b = bytes[i % bytes.length];
    // Rejection sampling keeps the distribution uniform.
    if (b >= 256 - (256 % REF_ALPHABET.length)) continue;
    out += REF_ALPHABET[b % REF_ALPHABET.length];
  }
  return out;
};

/** Opaque, high-entropy handle for upload sessions and device tokens. */
export const opaqueToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

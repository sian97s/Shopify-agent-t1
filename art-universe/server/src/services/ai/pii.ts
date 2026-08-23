import type { PiiResult } from './types.js';

const PATTERNS: [string, RegExp][] = [
  ['email', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  ['phone', /(?:\+?\d[\s().-]?){9,}\d/],
  ['url', /\b(?:https?:\/\/|www\.)[^\s]{4,}/i],
  ['social_handle', /(?:^|\s)@[a-z0-9._]{3,}\b/i],
  ['street_address', /\b\d{1,5}\s+[A-Z][a-z]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|blvd)\b/i],
  ['postal_code', /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b|\b\d{5}(-\d{4})?\b/],
  ['payment', /\b(?:\d[ -]?){13,19}\b/],
  ['messaging', /\b(whatsapp|telegram|signal|snapchat|dm me|text me)\b/i]
];

/** Detect personal or contact information in text lifted out of an image. */
export function detectPii(text: string): PiiResult {
  if (!text.trim()) return { found: false, kinds: [] };
  const kinds = PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  return { found: kinds.length > 0, kinds };
}

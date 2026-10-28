// SPDX-License-Identifier: Apache-2.0
'use strict';

// Some OpenAI-compatible reasoning endpoints occasionally return the requested
// complete document more than once. Only collapse byte-for-byte identical full
// copies; near-duplicates may contain real corrections and must stay untouched.
function collapseExactRepeatedText(value, { maxCopies = 8, minimumCopyChars = 40 } = {}) {
  const text = String(value || '').trim();
  if (!text) return { text, copies: 1 };
  const upper = Math.max(2, Math.min(32, Math.trunc(Number(maxCopies) || 8)));
  for (let copies = upper; copies >= 2; copies -= 1) {
    for (const separator of ['\n\n', '\n', '']) {
      const contentLength = text.length - separator.length * (copies - 1);
      if (contentLength < minimumCopyChars * copies || contentLength % copies !== 0) continue;
      const copyLength = contentLength / copies;
      const candidate = text.slice(0, copyLength);
      // A real fold/card is structured multi-line text. Without this guard a
      // legitimate value such as 100 repeated letters has infinitely many
      // possible periods and must not be guessed into a shorter document.
      if (!candidate.includes('\n')) continue;
      if (Array(copies).fill(candidate).join(separator) === text) {
        return { text: candidate, copies };
      }
    }
  }
  return { text, copies: 1 };
}

module.exports = { collapseExactRepeatedText };

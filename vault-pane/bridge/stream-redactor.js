'use strict';
// Keep only a suffix that could be the beginning of a secret. This works even
// when a log writes one byte at a time, without delaying ordinary log lines.
function streamRedactor(patterns, write) {
  let buffer = '';
  function flush(final) {
    const pairs = patterns().filter(p => p[0]).sort((a, b) => b[0].length - a[0].length);
    while (buffer) {
      let retain = buffer.length;
      if (!final) {
        for (const [needle] of pairs) {
          const max = Math.min(buffer.length, needle.length - 1);
          for (let n = max; n > 0; n--) {
            if (buffer.endsWith(needle.slice(0, n))) { retain = Math.min(retain, buffer.length - n); break; }
          }
        }
      }
      let found = null, at = Infinity;
      for (const pair of pairs) {
        const index = buffer.indexOf(pair[0]);
        if (index >= 0 && index < at) { found = pair; at = index; }
      }
      if (found && (at < retain || final)) {
        write(buffer.slice(0, at) + '«vault:' + found[1] + '»');
        buffer = buffer.slice(at + found[0].length);
      } else {
        if (retain) { write(buffer.slice(0, retain)); buffer = buffer.slice(retain); }
        break;
      }
    }
  }
  return { write(chunk) { buffer += chunk; flush(false); }, end() { flush(true); } };
}
module.exports = { streamRedactor };

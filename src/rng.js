// Seeded randomness.
//
// Every reproducible decision in dsh-turing-table comes out of this file:
// which seats are AI, which model config lands on which AI seat, how a seat
// disguises itself, and what the offline narrator says. There is no
// Math.random() and no Date.now() anywhere in the game engine, so the same
// seed plus the same player actions always produce the same table.

/** FNV-1a over UTF-16 code units with a final avalanche. Returns a uint32. */
export function hashSeed(input) {
  const text = String(input)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/**
 * mulberry32. Small, fast, and stable across Node versions — which matters
 * more here than statistical quality: a sample round generated on one machine
 * must regenerate byte for byte on another.
 */
export function createRng(seed) {
  const label = String(seed)
  let state = hashSeed(label)
  if (state === 0) state = 0x9e3779b9

  function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rng = {
    seed: label,
    next: next,
    float: next,
    /** Integer in [0, max). */
    int(max) {
      const bound = Math.floor(Number(max))
      if (!Number.isFinite(bound) || bound <= 0) {
        throw new RangeError('rng.int(max) needs a positive integer, got ' + String(max))
      }
      return Math.floor(next() * bound)
    },
    /** Integer in [min, max], inclusive on both ends. */
    range(min, max) {
      const lo = Math.ceil(Number(min))
      const hi = Math.floor(Number(max))
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
        throw new RangeError('rng.range(min, max) needs min <= max, got ' + String(min) + '/' + String(max))
      }
      return lo + rng.int(hi - lo + 1)
    },
    bool(probability) {
      const p = probability === undefined ? 0.5 : Number(probability)
      if (!Number.isFinite(p)) throw new RangeError('rng.bool(p) needs a number, got ' + String(probability))
      if (p <= 0) return false
      if (p >= 1) return true
      return next() < p
    },
    pick(list) {
      if (!Array.isArray(list) || list.length === 0) {
        throw new RangeError('rng.pick(list) needs a non-empty array')
      }
      return list[rng.int(list.length)]
    },
    /** Fisher-Yates on a copy; the input array is never touched. */
    shuffle(input) {
      const out = Array.from(input)
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1)
        const swap = out[i]
        out[i] = out[j]
        out[j] = swap
      }
      return out
    },
    /**
     * A named substream. Seat assignment, model assignment and every seat's
     * disguise draw from their own stream, so adding a question to a round
     * cannot reshuffle who is who.
     */
    fork(tag) {
      return createRng(label + '/' + String(tag))
    },
  }

  return rng
}

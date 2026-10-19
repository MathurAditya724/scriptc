"use native";
/* Internal key hashing and comparison shared by native maps and checked
 * objects (the native unit for scr_key.h's hash functions). Hashes never
 * escape into JavaScript values. */
import {
  Uint32,
  Uint64,
  inline,
  loadUnaligned,
  memcmp,
  type Pointer,
  type Size,
  type Uint8,
} from "@scriptc/experimental/native";

export const scr_key_mix = inline(function scr_key_mix(value: Uint64): Uint64 {
  value ^= value >> 30n;
  value *= 0xbf58476d1ce4e5b9n;
  value ^= value >> 27n;
  value *= 0x94d049bb133111ebn;
  return value ^ (value >> 31n);
});

/* Pack at most eight bytes with fixed-size, unaligned loads. The overlapping
 * ends cover every byte at lengths four through eight; the three selected
 * bytes cover lengths one through three. No terminator or padding is read. */
export const scr_key_short_word = inline(function scr_key_short_word(
  bytes: Pointer<Uint8>,
  length: Size,
): Uint64 {
  if (length >= 4n) {
    const first = loadUnaligned<Uint32>(bytes);
    const last = loadUnaligned<Uint32>(bytes.at(length).at(-4n));
    return (Uint64(first) << 32n) | Uint64(last);
  }
  if (length === 0n) return 0n;
  return (
    (Uint64(bytes.at(0n).get()) << 16n) |
    (Uint64(bytes.at(length / 2n).get()) << 8n) |
    Uint64(bytes.at(length - 1n).get())
  );
});

/* Callers check equal lengths first. Short keys need no out-of-line memcmp;
 * longer keys keep the platform's bulk comparison. */
export const scr_key_equal = inline(function scr_key_equal(
  a: Pointer<Uint8>,
  b: Pointer<Uint8>,
  length: Size,
): boolean {
  if (a === b) return true;
  if (length <= 8n) return scr_key_short_word(a, length) === scr_key_short_word(b, length);
  return memcmp(a, b, length) === 0n;
});

/* Unaligned loads stay inside the input. Hashing is process-local, so host
 * byte order is immaterial; equal byte strings always follow the same path.
 * Short keys need one avalanche and no variable-size tail copy. The length
 * selects a full-width seed: XORing it into the low bits would cancel
 * against the last byte ("ab" and "abc" used to collide). The compiler
 * mirrors this function for literals (string-key-hash.ts). */
export const scr_key_hash = inline(function scr_key_hash(
  bytes: Pointer<Uint8>,
  length: Size,
): Uint64 {
  let hash = 0x9e3779b97f4a7c15n * (Uint64(length) + 1n);
  if (length <= 8n) return scr_key_mix(hash ^ scr_key_short_word(bytes, length));
  let i: Size = 0n;
  while (length - i >= 8n) {
    const word = loadUnaligned<Uint64>(bytes.at(i));
    hash = scr_key_mix(hash ^ word);
    i += 8n;
  }
  return scr_key_mix(hash ^ scr_key_short_word(bytes.at(i), length - i));
});

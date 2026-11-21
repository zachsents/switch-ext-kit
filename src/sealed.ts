// Sealed answers: how a secret the user types reaches the one extension that asked for it without
// ever touching the brain, a chat or a model's context. The extension makes a one-time key pair
// (`sealedKey`), keeps the private half, and raises a sealed ask carrying the public half and what
// it's for (`use`). The user's client seals what they type to that key (`seal`); the core relays
// the sealed bytes to the extension's `answerTo` tool, which opens them (`openSealed`). The brain
// records only that it was answered.
//
// The seal is HPKE base mode (RFC 9180), single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
// AES-256-GCM, empty aad. The ask's id and its use are bound into the key schedule through `info`
// ("switch-sealed-v1", the item's id and the use, NUL-separated), so a sealed answer opens for no
// other ask or use. The iPhone seals the same way with CryptoKit's HPKE
// (`.Curve25519_SHA256_AES_GCM_256`). Only WebCrypto is used, so it runs in Bun and in a webview.

/** The prefix of `info`: Switch's sealed answers, this version of the binding. */
export const SEALED_DOMAIN = "switch-sealed-v1"

/** A secret sealed to a key: the encapsulated key and the ciphertext with its tag, each base64. */
export interface SealedAnswer {
  readonly enc: string
  readonly ct: string
}

const KEM = 0x00_20
const KDF = 0x00_01
const AEAD = 0x00_02

const text = new TextEncoder()
const subtle = (): SubtleCrypto => globalThis.crypto.subtle

const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Two bytes, big-endian. */
const u16 = (n: number) => new Uint8Array([Math.floor(n / 256) % 256, n % 256])

const b64 = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes))
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.codePointAt(0) ?? 0)
const unb64url = (s: string) => unb64(s.replaceAll("-", "+").replaceAll("_", "/"))

const hmac = async (key: Uint8Array, data: Uint8Array) => {
  // HMAC pads a short key with zeros, so an empty salt is the hash length of zeros.
  const k = await subtle().importKey(
    "raw",
    key.length === 0 ? new Uint8Array(32) : concat(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await subtle().sign("HMAC", k, concat(data)))
}

const VERSION = text.encode("HPKE-v1")

const extract = async (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  await hmac(salt, concat(VERSION, suite, text.encode(label), ikm))

// One block of HKDF-Expand: every length here is at most 32.
const expand = async (
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
) => {
  const labeled = concat(u16(length), VERSION, suite, text.encode(label), info)
  const block = await hmac(prk, concat(labeled, new Uint8Array([1])))
  return block.slice(0, length)
}

const KEM_SUITE = concat(text.encode("KEM"), u16(KEM))
const SUITE = concat(text.encode("HPKE"), u16(KEM), u16(KDF), u16(AEAD))
const EMPTY = new Uint8Array(0)

/** The `info` that binds a sealing to one item and one use. */
export const sealedInfo = (item: string, use: string): Uint8Array<ArrayBuffer> =>
  concat(
    text.encode(SEALED_DOMAIN),
    new Uint8Array([0]),
    text.encode(item),
    new Uint8Array([0]),
    text.encode(use),
  )

const sharedSecret = async (dh: Uint8Array, enc: Uint8Array, recipient: Uint8Array) => {
  const prk = await extract(KEM_SUITE, EMPTY, "eae_prk", dh)
  return await expand(KEM_SUITE, prk, "shared_secret", concat(enc, recipient), 32)
}

const schedule = async (shared: Uint8Array, info: Uint8Array) => {
  const pskId = await extract(SUITE, EMPTY, "psk_id_hash", EMPTY)
  const infoHash = await extract(SUITE, EMPTY, "info_hash", info)
  const context = concat(new Uint8Array([0]), pskId, infoHash)
  const secret = await extract(SUITE, shared, "secret", EMPTY)
  const key = await expand(SUITE, secret, "key", context, 32)
  const nonce = await expand(SUITE, secret, "base_nonce", context, 12)
  return {
    key: await subtle().importKey("raw", concat(key), "AES-GCM", false, ["encrypt", "decrypt"]),
    nonce: concat(nonce),
  }
}

const X25519 = { name: "X25519" }

const keyPair = async (): Promise<CryptoKeyPair> => {
  const made = await subtle().generateKey(X25519, true, ["deriveBits"])
  if ("privateKey" in made) {
    return made
  }
  throw new Error("X25519 made no key pair")
}

const dh = async (privateKey: CryptoKey, publicKey: CryptoKey) =>
  new Uint8Array(await subtle().deriveBits({ name: "X25519", public: publicKey }, privateKey, 256))

const importPublic = async (raw: Uint8Array) =>
  await subtle().importKey("raw", concat(raw), X25519, true, [])

/**
 * A one-time key pair for a sealed ask: `key` goes on the ask, `secretKey` stays with the extension
 * (in memory, or its Keychain while the ask waits) and opens the answer.
 */
export const sealedKey = async (): Promise<{ key: string; secretKey: string }> => {
  const pair = await keyPair()
  const jwk = await subtle().exportKey("jwk", pair.privateKey)
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey))
  return { key: b64(raw), secretKey: `${jwk.d ?? ""}.${jwk.x ?? ""}` }
}

/** Seals `secret` to an ask's `key`, bound to its item and use. What the user's client sends. */
export const seal = async (
  key: string,
  item: string,
  use: string,
  secret: string,
): Promise<SealedAnswer> => {
  const recipient = unb64(key)
  const ephemeral = await keyPair()
  const enc = new Uint8Array(await subtle().exportKey("raw", ephemeral.publicKey))
  const shared = await sharedSecret(
    await dh(ephemeral.privateKey, await importPublic(recipient)),
    enc,
    recipient,
  )
  const s = await schedule(shared, sealedInfo(item, use))
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: s.nonce }, s.key, text.encode(secret))
  return { enc: b64(enc), ct: b64(new Uint8Array(ct)) }
}

/** Opens a sealed answer for exactly this item and use; anything else, or tampered, throws. */
export const openSealed = async (
  secretKey: string,
  item: string,
  use: string,
  sealed: SealedAnswer,
): Promise<string> => {
  const [d = "", x = ""] = secretKey.split(".")
  const privateKey = await subtle().importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", d, x },
    X25519,
    false,
    ["deriveBits"],
  )
  const enc = unb64(sealed.enc)
  const shared = await sharedSecret(await dh(privateKey, await importPublic(enc)), enc, unb64url(x))
  const s = await schedule(shared, sealedInfo(item, use))
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: s.nonce }, s.key, unb64(sealed.ct))
  return new TextDecoder().decode(plain)
}

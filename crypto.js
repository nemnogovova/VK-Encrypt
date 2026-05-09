/**
 * VK Шифратор — Crypto Module
 * AES-GCM encryption/decryption (per-chat keys via PBKDF2)
 * ECDH P-256 key exchange for handshake-based key derivation
 * Fingerprint: SHA-256 of both public keys → emoji sequence
 */

const VKCrypto = (() => {
  const ENC_PREFIX = '\u{1F510}ENC:'; // 🔐ENC:
  const HS_PREFIX  = '\u{1F510}HS:';  // 🔐HS:
  const ENC_TEXT_TAG = 'ENC:';         // text after emoji img
  const HS_TEXT_TAG  = 'HS:';

  const SALT_LENGTH = 16;
  const IV_LENGTH   = 12;
  const PBKDF2_ITERATIONS = 100000;

  // 20 visually distinct emojis for fingerprint (animals — easy to read aloud)
  const FP_EMOJIS = [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
    '🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦆','🦅','🦋'
  ];

  // ─── AES-GCM ──────────────────────────────────────────────────────────────

  async function deriveKey(passphrase, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encrypt(plaintext, passphrase) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv   = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key  = await deriveKey(passphrase, salt);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext)
    );

    const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, SALT_LENGTH);
    combined.set(new Uint8Array(ciphertext), SALT_LENGTH + IV_LENGTH);

    return ENC_PREFIX + arrayBufferToBase64(combined);
  }

  async function decrypt(encryptedMessage, passphrase) {
    if (!isEncrypted(encryptedMessage)) return null;
    try {
      const combined  = base64ToArrayBuffer(encryptedMessage.slice(ENC_PREFIX.length));
      const salt      = combined.slice(0, SALT_LENGTH);
      const iv        = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);
      const key       = await deriveKey(passphrase, salt);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  function isEncrypted(text) {
    return typeof text === 'string' && text.startsWith(ENC_PREFIX);
  }

  // ─── ECDH / Handshake ─────────────────────────────────────────────────────

  async function generateECDHKeyPair() {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const pubRaw  = await crypto.subtle.exportKey('spki',  kp.publicKey);
    const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    return {
      publicKey:  arrayBufferToBase64(pubRaw),
      privateKey: arrayBufferToBase64(privRaw)
    };
  }

  async function deriveSharedPassphrase(myPrivKeyB64, theirPubKeyB64) {
    const privKey = await crypto.subtle.importKey(
      'pkcs8', base64ToArrayBuffer(myPrivKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, ['deriveBits']
    );
    const pubKey = await crypto.subtle.importKey(
      'spki', base64ToArrayBuffer(theirPubKeyB64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: pubKey }, privKey, 256
    );
    return arrayBufferToBase64(sharedBits);
  }

  async function computeFingerprint(pubKeyA_b64, pubKeyB_b64) {
    // Sort so both sides get the same result regardless of who is A/B
    const [k1, k2] = [pubKeyA_b64, pubKeyB_b64].sort();
    const data = new TextEncoder().encode(k1 + k2);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    // 8 emoji — from first 8 bytes of hash
    return Array.from(hash.slice(0, 8))
      .map(b => FP_EMOJIS[b % FP_EMOJIS.length])
      .join('');
  }

  // ─── Handshake message helpers ────────────────────────────────────────────

  function isHandshake(text) {
    return typeof text === 'string' && text.startsWith(HS_PREFIX);
  }

  // Returns { type: 'INIT'|'ACPT', pubKey: string } or null
  function parseHandshake(text) {
    if (!isHandshake(text)) return null;
    const body = text.slice(HS_PREFIX.length);
    const colon = body.indexOf(':');
    if (colon < 0) return null;
    return { type: body.slice(0, colon), pubKey: body.slice(colon + 1) };
  }

  function buildHandshakeMessage(type, pubKeyB64) {
    return HS_PREFIX + type + ':' + pubKeyB64;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  return {
    ENC_PREFIX,
    HS_PREFIX,
    ENC_TEXT_TAG,
    HS_TEXT_TAG,
    encrypt,
    decrypt,
    isEncrypted,
    isHandshake,
    parseHandshake,
    buildHandshakeMessage,
    generateECDHKeyPair,
    deriveSharedPassphrase,
    computeFingerprint
  };
})();

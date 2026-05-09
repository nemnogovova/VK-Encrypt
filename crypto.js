/**
 * VK Шифратор — Crypto Module
 * AES-GCM encryption/decryption using Web Crypto API
 * The key is derived from the user's passphrase via PBKDF2.
 */

const VKCrypto = (() => {
  const ENC_PREFIX = '\u{1F510}ENC:'; // 🔐ENC:
  const SALT_LENGTH = 16;
  const IV_LENGTH = 12;
  const PBKDF2_ITERATIONS = 100000;

  /**
   * Derive an AES-GCM key from a passphrase using PBKDF2
   */
  async function deriveKey(passphrase, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt a plaintext string with the given passphrase.
   * Returns a prefixed Base64 string: 🔐ENC:<base64(salt + iv + ciphertext)>
   */
  async function encrypt(plaintext, passphrase) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(passphrase, salt);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encoder.encode(plaintext)
    );

    // Combine: salt (16) + iv (12) + ciphertext
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

    return ENC_PREFIX + arrayBufferToBase64(combined);
  }

  /**
   * Decrypt a message previously encrypted with encrypt().
   * Returns the plaintext or null if decryption fails.
   */
  async function decrypt(encryptedMessage, passphrase) {
    if (!isEncrypted(encryptedMessage)) return null;

    try {
      const base64 = encryptedMessage.slice(ENC_PREFIX.length);
      const combined = base64ToArrayBuffer(base64);

      const salt = combined.slice(0, SALT_LENGTH);
      const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

      const key = await deriveKey(passphrase, salt);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
      );

      return new TextDecoder().decode(decrypted);
    } catch (e) {
      // Wrong key or corrupted data
      return null;
    }
  }

  /**
   * Check if a message is encrypted (has our prefix)
   */
  function isEncrypted(text) {
    return typeof text === 'string' && text.startsWith(ENC_PREFIX);
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ── ECDH Key Exchange ────────────────────────────────────────────────────

  /**
   * Generate an ECDH P-256 key pair.
   */
  async function generateECDHKeyPair() {
    return crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
  }

  /** Export the public key as a Base64 raw string. */
  async function exportPublicKeyB64(pubKey) {
    const raw = await crypto.subtle.exportKey('raw', pubKey);
    return arrayBufferToBase64(raw);
  }

  /** Import a Base64 raw public key into a CryptoKey. */
  async function importPublicKeyB64(b64) {
    const raw = base64ToArrayBuffer(b64);
    return crypto.subtle.importKey(
      'raw', raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
  }

  /** Export a private key as a JWK object (for storage). */
  async function exportPrivateKeyJWK(privKey) {
    return crypto.subtle.exportKey('jwk', privKey);
  }

  /** Import a private key from a stored JWK object. */
  async function importPrivateKeyJWK(jwk) {
    return crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
  }

  /**
   * Derive a shared passphrase from ECDH + HKDF.
   * Returns a 64-char hex string — used as the passphrase for encrypt/decrypt.
   */
  async function computePassphrase(myPrivKey, theirPubKeyB64) {
    const theirPubKey = await importPublicKeyB64(theirPubKeyB64);

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPubKey },
      myPrivKey,
      256
    );

    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveBits']
    );

    const derived = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('VK-Encrypt-v1')
      },
      hkdfKey,
      256
    );

    return Array.from(new Uint8Array(derived))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** 64 visually distinct emoji used for fingerprints. */
  const FP_EMOJI = [
    '🌀','🌊','🌈','🌙','⭐','🌺','🌸','🌻',
    '🍎','🍒','🍓','🎀','🎈','🎃','🎄','🎋',
    '🦁','🦊','🦋','🦌','🦒','🦓','🦔','🐉',
    '🐊','🐋','🐌','🐍','🐎','🐏','🐐','🐑',
    '🐒','🐓','🐔','🐕','🐘','🐙','🐚','🐛',
    '🐜','🐝','🐞','🐟','🐠','🐡','🐢','🐣',
    '🐤','🐥','🐦','🐧','🐨','🐩','🐪','🐫',
    '🦅','🦆','🦇','🦈','🦉','🦘','🦍','🦎'
  ];

  /**
   * Generate a 6-emoji fingerprint from two public key Base64 strings.
   * The order is canonicalised so both parties always get the same result.
   */
  async function fingerprintEmojis(pubKeyAB64, pubKeyBB64) {
    const [first, second] = [pubKeyAB64, pubKeyBB64].sort();
    const data = new TextEncoder().encode(first + '|' + second);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(hashBuf);
    return Array.from({ length: 6 }, (_, i) => FP_EMOJI[bytes[i] % FP_EMOJI.length]).join(' ');
  }

  return {
    ENC_PREFIX,
    encrypt,
    decrypt,
    isEncrypted,
    generateECDHKeyPair,
    exportPublicKeyB64,
    importPublicKeyB64,
    exportPrivateKeyJWK,
    importPrivateKeyJWK,
    computePassphrase,
    fingerprintEmojis
  };
})();

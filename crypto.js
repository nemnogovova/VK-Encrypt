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

  return {
    ENC_PREFIX,
    encrypt,
    decrypt,
    isEncrypted
  };
})();

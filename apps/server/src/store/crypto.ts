import crypto from 'node:crypto';

/**
 * Field-level encryption at rest for sensitive columns (transcripts, log entry text,
 * contacts). AES-256-GCM with a key derived from the configured passphrase via scrypt.
 *
 * Format of an encrypted value: `enc:v1:<saltB64>:<ivB64>:<tagB64>:<cipherB64>`.
 * A per-value random salt keeps this simple and self-contained (no separate key store)
 * for the personal-project MVP. This is a seam; a KMS can replace it later.
 */

const PREFIX = 'enc:v1:';

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32);
}

export function createCipher(passphrase: string) {
  return {
    encrypt(plain: string | null | undefined): string | null {
      if (plain == null) return null;
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = deriveKey(passphrase, salt);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return (
        PREFIX +
        [salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(
          ':',
        )
      );
    },

    decrypt(value: string | null | undefined): string | null {
      if (value == null) return null;
      if (!value.startsWith(PREFIX)) return value; // tolerate legacy/plaintext
      const rest = value.slice(PREFIX.length);
      const [saltB64, ivB64, tagB64, dataB64] = rest.split(':');
      if (!saltB64 || !ivB64 || !tagB64 || !dataB64) return value;
      const salt = Buffer.from(saltB64, 'base64');
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      const key = deriveKey(passphrase, salt);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return dec.toString('utf8');
    },
  };
}

export type Cipher = ReturnType<typeof createCipher>;

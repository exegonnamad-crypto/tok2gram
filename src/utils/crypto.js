const CryptoJS = require("crypto-js");
const config = require("../config");

const SECRET = config.encryptionKey;

/**
 * Encrypt sensitive data (Instagram passwords, session data)
 */
function encrypt(text) {
  if (!text) return "";
  return CryptoJS.AES.encrypt(text, SECRET).toString();
}

/**
 * Decrypt sensitive data
 */
function decrypt(ciphertext) {
  if (!ciphertext) return "";
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    return "";
  }
}

module.exports = { encrypt, decrypt };

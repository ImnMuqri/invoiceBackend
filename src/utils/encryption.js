const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts a string using AES-256-GCM
 * @param {string} text 
 * @returns {string} Encrypted text in format iv:authTag:encryptedText
 */
function encrypt(text) {
  if (!text) return null;
  
  const key = Buffer.from(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET, "utf-8").slice(0, 32);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag().toString("hex");
  
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a string using AES-256-GCM
 * @param {string} encryptedData 
 * @returns {string} Decrypted text
 */
function decrypt(encryptedData) {
  if (!encryptedData) return null;
  
  try {
    const [ivHex, authTagHex, encryptedText] = encryptedData.split(":");
    
    const key = Buffer.from(process.env.ENCRYPTION_KEY || process.env.JWT_SECRET, "utf-8").slice(0, 32);
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return decrypted;
  } catch (err) {
    console.error("Decryption failed:", err);
    return null;
  }
}

module.exports = { encrypt, decrypt };

let JSONdb = require('simple-json-db');
let crypto = require('node:crypto');
const { pbkdf2: deriveKey } = require("pbkdf2");
const events = require('node:events');
const util = require('node:util');
const fs = require("node:fs");

const DERIVATION_ROUNDS = 200000;
const HMAC_KEY_SIZE = 32;
const PASSWORD_KEY_SIZE = 32;

const defaultOptions = {
  asyncWrite: false,
  syncOnWrite: true,
  jsonSpaces: 4,
  stringify: JSON.stringify,
  parse: JSON.parse
};

function pbkdf2(password, salt, rounds, bits) {
  return new Promise((resolve, reject) => {
    deriveKey(password, salt, rounds, bits / 8, "sha256", (err, key) => {
      if (err) {
        return reject(err);
      }
      return resolve(key);
    });
  });
}

async function deriveFromPassword(password, salt, rounds) {
  if (!password) {
    throw new Error("Failed deriving key: Password must be provided");
  }
  if (!salt) {
    throw new Error("Failed deriving key: Salt must be provided");
  }
  if (!rounds || rounds <= 0 || typeof rounds !== "number") {
    throw new Error("Failed deriving key: Rounds must be greater than 0");
  }
  const bits = (PASSWORD_KEY_SIZE + HMAC_KEY_SIZE) * 8;
  const derivedKeyData = await pbkdf2(password, salt, rounds, bits);
  const derivedKeyHex = derivedKeyData.toString("hex");
  return Buffer.from(derivedKeyHex.slice(0, derivedKeyHex.length / 2), "hex");
}

function generateSalt(length) {
  if (length <= 0) {
    throw new Error(`Failed generating salt: Invalid length supplied: ${length}`);
  }
  let output = "";
  while (output.length < length) {
    output += crypto.randomBytes(3).toString("base64");
    if (output.length > length) {
      output = output.slice(0, length);
    }
  }
  return output;
}

function validateJSON(fileContent) {
  try {
    JSON.parse(fileContent);
  } catch (e) {
    throw new Error('Given filePath is not empty and its content is not valid JSON.');
  }
  return true;
}

class EncryptedStorage {

  /**
   * Main constructor, manages existing storage file and parses options against default ones.
   * @param {string} filePath The path of the file to use as storage.
   * @param {string} iv Encryption initialization vector
   * @param {string} salt Password salt used to derive the key
   * @param {string} password Encryption password
   * @param {object} [options] Configuration options.
   * @param {boolean} [options.asyncWrite] Enables the storage to be asynchronously written to disk. Disabled by default (synchronous behaviour).
   * @param {boolean} [options.syncOnWrite] Makes the storage be written to disk after every modification. Enabled by default.
   * @param {boolean} [options.syncOnWrite] Makes the storage be written to disk after every modification. Enabled by default.
   * @param {number} [options.jsonSpaces] How many spaces to use for indentation in the output json files. Default = 4
   * @param {object} [options.newData] Data that will be encrypted for the first time
   * @constructor
   */
  _checkFileAccess(filePath) {
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }
      if (err.code === 'EACCES') {
        throw new Error(`Cannot access path "${filePath}".`);
      }
      throw new Error(`Error while checking for existence of path "${filePath}": ${err}`);
    }
    try {
      fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      throw new Error(`Cannot read & write on path "${filePath}". Check permissions!`);
    }
    return stats;
  }

  constructor(filePath, password, options) {
    if (!filePath || !filePath.length) {
      throw new Error('Missing file path argument.');
    }
    this.filePath = filePath;
    this.options = Object.assign({}, defaultOptions, options);
    this.storage = {};

    if (this.options.newData) {
      this._initNewData(password, this.options.newData);
      return;
    }

    const stats = this._checkFileAccess(filePath);
    if (!stats) {
      this._initFreshDatabase(password, { sync: true });
      return;
    }

    if (stats.size > 0) {
      this._loadExistingFile(filePath, password);
    } else {
      this._initFreshDatabase(password, { sync: false });
    }
  }

  /**
   * Seed a brand-new database from caller-supplied plaintext data and persist
   * it. Any derivation/sync error is reported via the 'error' event.
   * @param {string} password
   * @param {object} newData
   * @private
   */
  _initNewData(password, newData) {
    this.iv = crypto.randomBytes(16).toString('hex');
    this.salt = generateSalt(12);

    deriveFromPassword(password, this.salt, DERIVATION_ROUNDS).then(derivedKey => {
      try {
        this.derivedKey = derivedKey;
        this.storage = newData;
        this.sync();
        this.emit('loaded');
      } catch (error) {
        this.emit('error', error);
      }
    });
  }

  /**
   * Initialize a fresh, empty database with new iv/salt and a derived key.
   * When `opts.sync` is true (missing-file case) the empty DB is written to
   * disk; when false (zero-byte existing file) nothing is written until the
   * caller performs a sync. Errors are reported via the 'error' event.
   * @param {string} password
   * @param {{sync: boolean}} opts
   * @private
   */
  _initFreshDatabase(password, opts) {
    this.iv = crypto.randomBytes(16).toString('hex');
    this.salt = generateSalt(12);

    deriveFromPassword(password, this.salt, DERIVATION_ROUNDS).then(derivedKey => {
      try {
        this.derivedKey = derivedKey;
        if (opts && opts.sync) this.sync();
        this.emit('loaded');
      } catch (error) {
        this.emit('error', error);
      }
    }).catch(error => {
      this.emit('error', error);
    });
  }

  /**
   * Load and decrypt an existing, non-empty storage file.
   *
   * This path NEVER writes to disk, so a wrong password / corrupted / truncated
   * file can never overwrite or truncate the existing data. Any failure (read
   * error, invalid JSON, missing fields, decryption failure) is reported via
   * the 'error' event instead of throwing from the constructor.
   * @param {string} filePath
   * @param {string} password
   * @private
   */
  _loadExistingFile(filePath, password) {
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch (err) {
      Promise.resolve().then(() => this.emit('error', err));
      return;
    }

    let input_data;
    try {
      if (!validateJSON(data)) {
        throw new Error('Given filePath is not empty and its content is not valid JSON.');
      }
      input_data = JSON.parse(data);
      if (!input_data.iv || !input_data.salt || !input_data.data) {
        throw new Error('Invalid file');
      }
    } catch (err) {
      Promise.resolve().then(() => this.emit('error', err));
      return;
    }

    this.iv = input_data.iv;
    this.salt = input_data.salt;

    deriveFromPassword(password, this.salt, DERIVATION_ROUNDS).then(derivedKey => {
      try {
        this.derivedKey = derivedKey;

        const decryptTool = crypto.createDecipheriv("aes-256-cbc", this.derivedKey, Buffer.from(this.iv, 'hex'));
        let decryptedData = decryptTool.update(input_data.data, "base64", "utf8");
        decryptedData += decryptTool.final("utf8");

        if (validateJSON(decryptedData)) {
          this.storage = JSON.parse(decryptedData);
        }
        this.emit('loaded');
      } catch (error) {
        // Decryption failed (BAD_DECRYPT / wrong password / corrupted
        // ciphertext / invalid JSON). Do NOT write anything; just report.
        this.emit('error', error);
      }
    }).catch(error => {
      this.emit('error', error);
    });
  }

  sync() {
    const json = JSON.stringify(this.storage, null, this.options.jsonSpaces);

    // SECURITY / SonarQube "use a secure mode and padding scheme" (AES-CBC):
    // ACCEPTED RISK, deliberately kept as aes-256-cbc. This is local-only,
    // at-rest encryption of the user's OWN account database on their OWN disk.
    // The key is derived (pbkdf2-sha256, 200000 rounds) from a password only the
    // user knows; there is no network, no untrusted party, and no
    // chosen-ciphertext / tampering threat model for a self-owned local JSON
    // file. Switching to an authenticated mode (AES-GCM) would change the
    // on-disk envelope (a GCM auth tag is required) and therefore BRICK every
    // existing user database written under the current {iv,salt,data} CBC format
    // - a far worse outcome than the theoretical weakness the scanner flags.
    // Backward-compatibility of already-encrypted user data outranks silencing
    // this finding. See test/storage.js: the hard-coded CBC fixtures
    // (password 'fixture-password-v1') and the on-disk-format test pin this
    // envelope and must keep passing.
    const encryptTool = crypto.createCipheriv("aes-256-cbc", this.derivedKey, Buffer.from(this.iv, 'hex'));
  
    let encryptedData = encryptTool.update(json, "utf8", "base64");
    encryptedData += encryptTool.final("base64");

    const finalJson = JSON.stringify({
      iv: this.iv,
      salt: this.salt,
      data: encryptedData
    })

    // Atomic write: write to a temporary file first, then rename it over the
    // target. fs.renameSync is atomic on the same filesystem, so a crash
    // mid-write can never leave the database in a partially-written state.
    const tmpPath = this.filePath + '.tmp';

    if (this.options && this.options.asyncWrite) {
      fs.writeFile(tmpPath, finalJson, (err) => {
        if (err) throw err;
        try {
          fs.renameSync(tmpPath, this.filePath);
        } catch (renameErr) {
          try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore cleanup failure */ }
          throw renameErr;
        }
      });
    } else {
      try {
        fs.writeFileSync(tmpPath, finalJson);
        fs.renameSync(tmpPath, this.filePath);
      } catch (err) {
        // Clean up any leftover temp file so a failed sync leaves no debris and
        // the original target intact.
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore cleanup failure */ }
        if (err.code === 'EACCES') {
          throw new Error(`Cannot access path "${this.filePath}".`);
        } else {
          throw new Error(`Error while writing to path "${this.filePath}": ${err}`);
        }
      }
    }
  }
}

util.inherits(JSONdb, events.EventEmitter);
util.inherits(EncryptedStorage, JSONdb);

module.exports = EncryptedStorage;
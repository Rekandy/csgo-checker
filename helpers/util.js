module.exports = {
  penalty_reason_string,
  penalty_reason_permanent,
  protoDecode,
  protoEncode
}

// Lookup table for penalty reason ids -> human-readable strings.
// NOTE: id 0 maps to the numeric value 0 (not a string) - preserved exactly.
// Shared cases: 8 & 14 -> "Untrusted"; 18, 19 & 20 -> "Rank Calibration".
const PENALTY_REASON_STRINGS = new Map([
  [0, 0],
  [1, "Kicked"],
  [2, "TK Limit"],
  [3, "TK Spawn"],
  [4, "Disconnected Too Long"],
  [5, "Abandon"],
  [6, "TD Limit"],
  [7, "TD Spawn"],
  [8, "Untrusted"],
  [14, "Untrusted"],
  [9, "Kicked Too Much"],
  [10, "Overwatch (Cheat)"],
  [11, "Overwatch (Grief)"],
  [16, "Failed To Connect"],
  [17, "Kick Abuse"],
  [18, "Rank Calibration"],
  [19, "Rank Calibration"],
  [20, "Rank Calibration"],
  [21, "Reports (Grief)"]
]);

// Penalty reason ids that represent a permanent ban.
const PENALTY_REASON_PERMANENT = new Set([8, 14, 10]);

function penalty_reason_string(id) {
  return PENALTY_REASON_STRINGS.has(id)
    ? PENALTY_REASON_STRINGS.get(id)
    : `Unknown(${id})`;
}

function penalty_reason_permanent(id) {
  return PENALTY_REASON_PERMANENT.has(id);
}

function protoDecode(proto, obj) {
  try {
    // Check if proto exists and has the required methods
    if (!proto || typeof proto.decode !== 'function' || typeof proto.toObject !== 'function') {
      console.error('Invalid proto object provided to protoDecode');
      return {};
    }

    // Check if obj is a valid buffer
    if (!Buffer.isBuffer(obj) && !(obj instanceof Uint8Array)) {
      console.error('Invalid buffer provided to protoDecode');
      return {};
    }

    // Try to decode the buffer
    let decoded;
    try {
      decoded = proto.decode(obj);
    } catch (decodeError) {
      console.error('Failed to decode protocol buffer:', decodeError.message);
      return {};
    }

    // Convert to JavaScript object
    try {
      return proto.toObject(decoded, { defaults: true, longs: String, enums: String });
    } catch (toObjectError) {
      console.error('Failed to convert protocol buffer to object:', toObjectError.message);
      return {};
    }
  } catch (error) {
    console.error('Unexpected error in protoDecode:', error);
    return {};
  }
}

function protoEncode(proto, obj) {
  try {
    // Check if proto exists and has the required methods
    if (!proto || typeof proto.create !== 'function' || typeof proto.encode !== 'function') {
      console.error('Invalid proto object provided to protoEncode');
      return Buffer.alloc(0);
    }

    // Check if obj is a valid object
    if (!obj || typeof obj !== 'object') {
      console.error('Invalid object provided to protoEncode');
      return Buffer.alloc(0);
    }

    // Create a message from the object
    let message;
    try {
      message = proto.create(obj);
    } catch (createError) {
      console.error('Failed to create protocol buffer message:', createError.message);
      return Buffer.alloc(0);
    }

    // Encode the message to a buffer
    try {
      return proto.encode(message).finish();
    } catch (encodeError) {
      console.error('Failed to encode protocol buffer message:', encodeError.message);
      return Buffer.alloc(0);
    }
  } catch (error) {
    console.error('Unexpected error in protoEncode:', error);
    return Buffer.alloc(0);
  }
}
module.exports = {
  penalty_reason_string,
  penalty_reason_permanent,
  protoDecode,
  protoEncode
}

function penalty_reason_string(id) {
  switch (id)
  {
  case 0: return 0;
  case 1: return "Kicked";
  case 2: return "TK Limit";
  case 3: return "TK Spawn";
  case 4: return "Disconnected Too Long";
  case 5: return "Abandon";
  case 6: return "TD Limit";
  case 7: return "TD Spawn";
  case 8: 
  case 14: return "Untrusted";
  case 9: return "Kicked Too Much";
  case 10: return "Overwatch (Cheat)";
  case 11: return "Overwatch (Grief)";
  case 16: return "Failed To Connect";
  case 17: return "Kick Abuse";
  case 18: 
  case 19: 
  case 20: return "Rank Calibration";
  case 21: return "Reports (Grief)"
  default: return `Unknown(${id})`;
  }
}

function penalty_reason_permanent(id) {
  switch (id)
  {
  case 8: 
  case 14:
  case 10:
    return true;
  default: 
    return false;
  }
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
const Protobuf = require("protobufjs");
const fs = require("fs");
const path = require("path");

module.exports = Protos;

/**
 * Load protobuf definitions and return a map of named proto sets.
 * @param {Array<{name: string, protos: string[]|string}>} protos - Array of proto sets to load.
 *   Each entry has a `name` and `protos` which is either an array of file paths or a directory path.
 * @param {boolean} [ignoreErrors=true] - Whether to suppress load errors.
 * @returns {Object} Map of {name: {TypeName: protobufjs.Type, ...}}
 */
function Protos(protos, ignoreErrors = true) {
	const protobufs = {};

	// Message types to export from each proto set
	const messageTypes = [
		"CMsgClientWelcome",
		"CSOEconGameAccountClient",
		"CMsgGCCStrike15_v2_MatchmakingGC2ClientHello",
		"CMsgGCCStrike15_v2_ClientGCRankUpdate",
		"CMsgGCCStrike15_v2_PlayersProfile",
		"CMsgGCCStrike15_v2_ClientRequestPlayersProfile",
		"PlayerRankingInfo",
		"PlayerCommendationInfo",
		"PlayerMedalsInfo",
		"CMsgClientHello"
	];

	for (let proto of protos) {
		// Create a single root for this proto set
		const root = new Protobuf.Root();

		// Get the list of proto files
		let files;
		if (Array.isArray(proto.protos)) {
			files = proto.protos;
		} else {
			// It's a directory path - read all .proto files from it
			files = fs.readdirSync(proto.protos)
				.filter(f => f.endsWith(".proto"))
				.map(f => path.join(proto.protos, f));
		}

		// Determine the proto include directory from the first file
		// All proto files should be in the same directory for import resolution
		let protosDir = null;
		for (const file of files) {
			if (file.endsWith(".proto") && fs.existsSync(file)) {
				protosDir = path.dirname(path.resolve(file));
				break;
			}
		}

		if (!protosDir) {
			if (!ignoreErrors) {
				throw new Error(`No valid proto files found for ${proto.name}`);
			}
			protobufs[proto.name] = {};
			continue;
		}

		// Set up custom import resolution so cross-file imports work
		root.resolvePath = function (origin, target) {
			// For google/protobuf imports, let protobufjs handle them with its built-in definitions
			if (target.startsWith("google/protobuf/")) {
				return target;
			}
			// Resolve all other imports relative to the protos directory
			return path.resolve(protosDir, target);
		};

		// Load all proto files into the same root
		for (const file of files) {
			if (!file.endsWith(".proto")) {
				continue;
			}

			const resolvedFile = path.resolve(file);
			if (!fs.existsSync(resolvedFile)) {
				if (!ignoreErrors) {
					throw new Error(`Proto file not found: ${resolvedFile}`);
				}
				continue;
			}

			try {
				root.loadSync(resolvedFile, {
					keepCase: true,
					alternateCommentMode: true
				});
			} catch (err) {
				if (!ignoreErrors) {
					throw err;
				}
				console.error(`Error loading proto file ${resolvedFile}: ${err.message}`);
			}
		}

		// Build the type map for this proto set
		const typeMap = {};
		for (const typeName of messageTypes) {
			try {
				typeMap[typeName] = root.lookupType(typeName);
			} catch (err) {
				// Type may not exist in this particular set of proto files
				if (!ignoreErrors) {
					throw new Error(`Failed to look up type ${typeName}: ${err.message}`);
				}
			}
		}

		protobufs[proto.name] = typeMap;
	}

	return protobufs;
}

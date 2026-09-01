const Protobuf = require("protobufjs");
const fs = require("node:fs");
const path = require("node:path");

module.exports = Protos;

/**
 * Load protobuf definitions and return a map of named proto sets.
 * @param {Array<{name: string, protos: string[]|string}>} protos - Array of proto sets to load.
 *   Each entry has a `name` and `protos` which is either an array of file paths or a directory path.
 * @param {boolean} [ignoreErrors=true] - Whether to suppress load errors.
 * @returns {Object} Map of {name: {TypeName: protobufjs.Type, ...}}
 */
// Message types to export from each proto set.
const MESSAGE_TYPES = [
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

/**
 * Resolve a proto set's `protos` entry to a concrete list of .proto file paths.
 * Accepts either an explicit array of paths or a directory to scan.
 * @param {string[]|string} protosEntry
 * @returns {string[]}
 */
function resolveProtoFiles(protosEntry) {
	if (Array.isArray(protosEntry)) {
		return protosEntry;
	}
	// It's a directory path - read all .proto files from it
	return fs.readdirSync(protosEntry)
		.filter(f => f.endsWith(".proto"))
		.map(f => path.join(protosEntry, f));
}

/**
 * Determine the proto include directory from the first existing .proto file.
 * All proto files should be in the same directory for import resolution.
 * @param {string[]} files
 * @returns {string|null} directory path, or null if no valid file found
 */
function findProtosDir(files) {
	for (const file of files) {
		if (file.endsWith(".proto") && fs.existsSync(file)) {
			return path.dirname(path.resolve(file));
		}
	}
	return null;
}

/**
 * Build the custom protobufjs import resolver for a given protos directory so
 * cross-file imports work.
 * @param {string} protosDir
 * @returns {function(string, string): string}
 */
function makeResolvePath(protosDir) {
	return function (origin, target) {
		// protobufjs 7 no longer bundles google/protobuf/descriptor.proto in
		// its "common" registry (protobufjs 6 did). The Steam .proto files
		// declare custom options by extending google.protobuf.*Options, so we
		// resolve descriptor.proto to the minimal local copy shipped under
		// protos/google/protobuf/ instead.
		if (target === "google/protobuf/descriptor.proto") {
			return path.resolve(protosDir, "google", "protobuf", "descriptor.proto");
		}
		// For the remaining google/protobuf imports, let protobufjs handle
		// them with its built-in "common" definitions.
		if (target.startsWith("google/protobuf/")) {
			return target;
		}
		// Resolve all other imports relative to the protos directory
		return path.resolve(protosDir, target);
	};
}

/**
 * Load all .proto files into the given root.
 * @param {Protobuf.Root} root
 * @param {string[]} files
 * @param {boolean} ignoreErrors
 */
function loadProtoFiles(root, files, ignoreErrors) {
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
}

/**
 * Look up the exported message types from a loaded root into a type map.
 * @param {Protobuf.Root} root
 * @param {boolean} ignoreErrors
 * @returns {Object} {TypeName: protobufjs.Type, ...}
 */
function buildTypeMap(root, ignoreErrors) {
	const typeMap = {};
	for (const typeName of MESSAGE_TYPES) {
		try {
			typeMap[typeName] = root.lookupType(typeName);
		} catch (err) {
			// Type may not exist in this particular set of proto files
			if (!ignoreErrors) {
				throw new Error(`Failed to look up type ${typeName}: ${err.message}`);
			}
		}
	}
	return typeMap;
}

function Protos(protos, ignoreErrors = true) {
	const protobufs = {};

	for (let proto of protos) {
		// Create a single root for this proto set
		const root = new Protobuf.Root();

		const files = resolveProtoFiles(proto.protos);
		const protosDir = findProtosDir(files);

		if (!protosDir) {
			if (!ignoreErrors) {
				throw new Error(`No valid proto files found for ${proto.name}`);
			}
			protobufs[proto.name] = {};
			continue;
		}

		// Set up custom import resolution so cross-file imports work
		root.resolvePath = makeResolvePath(protosDir);

		loadProtoFiles(root, files, ignoreErrors);

		protobufs[proto.name] = buildTypeMap(root, ignoreErrors);
	}

	return protobufs;
}

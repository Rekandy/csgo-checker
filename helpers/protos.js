const Protobuf = require("protobufjs");
const fs = require("fs");
const path = require("path");

module.exports = Protos;

function Protos(protos, ignoreErrors = true) {
	const protobufs = {};

	for (let proto of protos) {
		console.log(`Loading proto files for ${proto.name}...`);
		
		// Create a new root for each proto set
		let root = new Protobuf.Root();
		
		// Get the list of proto files
		let files = Array.isArray(proto.protos) ? proto.protos : fs.readdirSync(proto.protos).map(file => path.join(proto.protos, file));
		console.log(`Found ${files.length} proto files`);

		// Load each proto file individually to avoid duplicate definitions
		const loadedTypes = {};
		
		// Process each file separately
		for (let file of files) {
			if (!file.endsWith(".proto") || !fs.existsSync(file)) {
				console.log(`Skipping file ${file} - not a proto file or doesn't exist`);
				continue;
			}

			try {
				console.log(`Processing proto file: ${file}`);
				
				// Read the file content
				let content = fs.readFileSync(file, 'utf8');
				
				// Make sure the proto file has the necessary options
				if (!content.includes('option optimize_for = SPEED;')) {
					console.log(`Adding optimize_for option to ${file}`);
					let insertPoint = content.indexOf('\n', content.indexOf('import'));
					if (insertPoint === -1) insertPoint = 0;
					content = content.slice(0, insertPoint) + '\n\noption optimize_for = SPEED;\noption cc_generic_services = false;' + content.slice(insertPoint);
				}
				
				// Add key_field extension if it's steammessages.proto
				if (path.basename(file) === "steammessages.proto" && !content.includes('key_field')) {
					console.log(`Adding key_field extension to ${file}`);
					let insertPoint = content.indexOf('extend .google.protobuf.FieldOptions {');
					if (insertPoint !== -1) {
						let endPoint = content.indexOf('}', insertPoint);
						if (endPoint !== -1) {
							content = content.slice(0, endPoint) + '\n\toptional bool key_field = 50000 [default = false];' + content.slice(endPoint);
						}
					}
				}
				
				// Create a temporary file with the modified content
				let tempFile = file + '.temp';
				fs.writeFileSync(tempFile, content);
				
				// Create a separate root for each file to avoid conflicts
				let fileRoot = new Protobuf.Root();
				try {
					fileRoot = fileRoot.loadSync(tempFile, {
						keepCase: true,
						alternateCommentMode: true
					});
					
					// Extract all message types from this file
					const nestedTypes = fileRoot.nested || {};
					Object.keys(nestedTypes).forEach(typeName => {
						if (!loadedTypes[typeName]) {
							loadedTypes[typeName] = nestedTypes[typeName];
						}
					});
					
					console.log(`Successfully processed proto file: ${file}`);
				} catch (loadErr) {
					console.error(`Error loading proto file ${file} into separate root:`, loadErr);
				}
				
				// Remove the temporary file
				try {
					fs.unlinkSync(tempFile);
				} catch (unlinkErr) {
					console.error(`Error removing temporary file ${tempFile}:`, unlinkErr);
				}
			} catch (err) {
				console.error(`Error processing proto file ${file}:`, err);
				if (!ignoreErrors) {
					throw err;
				}
			}
		}

		// Now create a simplified version of the proto definitions
		// that only includes what we need for CS2
		const simplifiedRoot = new Protobuf.Root();
		
		// Add essential message types for CS2
		const essentialTypes = [
			'CMsgClientWelcome',
			'CSOEconGameAccountClient',
			'CMsgGCCStrike15_v2_MatchmakingGC2ClientHello',
			'CMsgGCCStrike15_v2_ClientGCRankUpdate'
		];
		
		// Create a simplified proto file with just what we need
		let simplifiedProto = `
		option optimize_for = SPEED;
		option cc_generic_services = false;
		
		extend .google.protobuf.FieldOptions {
			optional bool key_field = 50000 [default = false];
		}
		
		// Essential message types for CS2
		message CMsgClientWelcome {
			repeated .CMsgClientWelcome.OutOfDateSubscribedCache outofdate_subscribed_caches = 3;
			
			message OutOfDateSubscribedCache {
				repeated .CMsgClientWelcome.OutOfDateSubscribedCache.CacheObject objects = 2;
				
				message CacheObject {
					optional uint32 type_id = 1;
					repeated bytes object_data = 2;
				}
			}
		}
		
		message CSOEconGameAccountClient {
			optional uint32 additional_backpack_slots = 1 [default = 0];
			optional fixed32 bonus_xp_timestamp_refresh = 12;
			optional uint32 bonus_xp_usedflags = 13;
			optional uint32 elevated_state = 14;
			optional uint32 elevated_timestamp = 15;
		}
		
		message CMsgGCCStrike15_v2_MatchmakingGC2ClientHello {
			optional uint32 account_id = 1;
			optional uint32 penalty_reason = 2;
			optional uint32 penalty_seconds = 3;
			optional uint32 vac_banned = 6;
			optional .PlayerRankingInfo ranking = 7;
			optional .PlayerCommendationInfo commendation = 8;
			optional .PlayerMedalsInfo medals = 9;
			optional uint32 player_level = 11;
		}
		
		message PlayerRankingInfo {
			optional uint32 account_id = 1;
			optional uint32 rank_id = 2;
			optional uint32 wins = 3;
			optional float rank_change = 4;
			optional uint32 rank_type_id = 6;
		}
		
		message PlayerCommendationInfo {
			optional uint32 cmd_friendly = 1;
			optional uint32 cmd_teaching = 2;
			optional uint32 cmd_leader = 4;
		}
		
		message PlayerMedalsInfo {
			repeated uint32 display_items_defidx = 7;
			optional uint32 featured_display_item_defidx = 8;
		}
		
		message CMsgGCCStrike15_v2_ClientGCRankUpdate {
			repeated .PlayerRankingInfo rankings = 1;
		}
		`;
		
		// Create a temporary file with the simplified proto
		let simplifiedFile = path.join(path.dirname(files[0]), 'simplified.proto.temp');
		fs.writeFileSync(simplifiedFile, simplifiedProto);
		
		// Load the simplified proto
		try {
			root = root.loadSync(simplifiedFile, {
				keepCase: true,
				alternateCommentMode: true
			});
			console.log('Successfully loaded simplified proto definitions');
		} catch (err) {
			console.error('Error loading simplified proto definitions:', err);
			if (!ignoreErrors) {
				throw err;
			}
		}
		
		// Clean up
		try {
			fs.unlinkSync(simplifiedFile);
		} catch (err) {
			console.error(`Error removing temporary file ${simplifiedFile}:`, err);
		}

		// Verify that the root has been populated correctly
		if (Object.keys(root.nested || {}).length === 0) {
			console.warn(`Warning: No message types found in proto files for ${proto.name}`);
		} else {
			console.log(`Successfully loaded ${Object.keys(root.nested || {}).length} message types for ${proto.name}`);
		}

		protobufs[proto.name] = root;
	}

	return protobufs;
}
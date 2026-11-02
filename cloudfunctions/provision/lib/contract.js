'use strict';
const { createHash } = require('node:crypto');
const manifest = require('../collections.json');
const digest = value => createHash('sha256').update(value).digest('hex');
const schemaVersion = 1;
const canonicalManifest = JSON.stringify({ schemaVersion, collections: manifest.collections, indexes: manifest.indexes, clientRules: manifest.clientRules });
const manifestHash = digest(canonicalManifest);
const markerKey = name => digest(name).slice(0, 32);
function matchesMarker(value, appId, envId) {
  return !!value && value.schemaVersion === schemaVersion && value.manifestHash === manifestHash && value.appId === appId && value.envId === envId;
}
module.exports = { manifest, digest, schemaVersion, canonicalManifest, manifestHash, markerKey, matchesMarker };

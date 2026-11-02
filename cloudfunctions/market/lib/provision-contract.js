'use strict';
const manifest=require('../collections.json');
const {createHash}=require('node:crypto');
const schemaVersion=1;
// Property order and manifest array order are part of this deployment contract.
// Descriptive prose is deliberately excluded from the readiness fingerprint.
const canonicalManifest=JSON.stringify({schemaVersion,collections:manifest.collections,indexes:manifest.indexes,clientRules:manifest.clientRules});
const manifestHash=createHash('sha256').update(canonicalManifest).digest('hex');
module.exports={schemaVersion,canonicalManifest,manifestHash};

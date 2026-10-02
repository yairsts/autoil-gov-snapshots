const {createHash} = require('node:crypto');

const SHARD_COUNT = 64;
const PREFIX = 'gov-resources';

function shardNumber(key, count = SHARD_COUNT) {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % count;
}

function manifestKey(resource) {
  return `${PREFIX}/${resource.id}/current.json`;
}

function shardKey(resource, version, number) {
  return `${PREFIX}/${resource.id}/versions/${version}/${String(number).padStart(2, '0')}.jsonl.gz`;
}

module.exports = {SHARD_COUNT, shardNumber, manifestKey, shardKey};

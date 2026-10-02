const PREFIX = 'private-vehicles';
const SHARD_COUNT = 128;
const MANIFEST_KEY = `${PREFIX}/current.json`;

function shardNumber(plateNumber) {
  const plate = String(plateNumber).padStart(8, '0');
  if (!/^\d{8}$/.test(plate)) throw new Error('Invalid plate number');
  return Number(plate.slice(-3)) % SHARD_COUNT;
}

function shardKey(version, number) {
  return `${PREFIX}/versions/${version}/${String(number).padStart(3, '0')}.jsonl.gz`;
}

module.exports = {MANIFEST_KEY, SHARD_COUNT, shardNumber, shardKey};

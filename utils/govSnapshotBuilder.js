const {createHash} = require('node:crypto');
const {once} = require('node:events');
const {createWriteStream} = require('node:fs');
const {stat} = require('node:fs/promises');
const {join} = require('node:path');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {createGzip} = require('node:zlib');
const {parse} = require('csv-parse');
const {parse: parseRow} = require('csv-parse/sync');
const {lookupKey} = require('../constants/govResources');
const {shardNumber} = require('./govSnapshotLayout');

const MAX_STORED_BYTES = 500_000_000;

function csvOptions(resource) {
  return {columns: true, delimiter: resource.delimiter, bom: true,
    skip_empty_lines: true, relax_quotes: true,
    ...(resource.repairQuotes && {raw: true, relax_column_count: true,
      on_record: (row, context) => repairQuotedRow(row, context, resource.delimiter)})};
}

function unquoteCell(cell) {
  if (!cell.startsWith('"') || !cell.endsWith('"')) return cell;
  return cell.slice(1, -1).replaceAll('""', '"');
}

function repairQuotedRow({raw, record}, context, delimiter) {
  if (!context.error) return record;
  const repaired = raw.replace(/(^|\|)"([^"\r\n]+)""(?=\||\r?$)/gm, '$1"$2"""');
  if (repaired !== raw) {
    const rows = parseRow(repaired, {columns: context.columns.map(({name}) => name),
      delimiter, relax_quotes: true});
    if (rows.length !== 1) throw context.error;
    return rows[0];
  }
  // Use normal CSV parsing for valid quoted pipes. Repair only an inconsistent
  // single-line row whose raw delimiters recover EVERY expected column.
  const line = raw.trimEnd();
  const cells = line.split(delimiter);
  const columns = context.columns;
  if (/[\r\n]/.test(line) || cells.length !== columns.length) throw context.error;
  return Object.fromEntries(columns.map(({name}, i) => [name, unquoteCell(cells[i])]));
}

function normalizeRow(resource, row, id) {
  for (const field of [...resource.keyFields, ...(resource.requiredFields || [])]) {
    if (!Object.hasOwn(row, field)) throw new Error(`CSV is missing ${field}`);
  }
  const record = {_id: id};
  for (const [field, value] of Object.entries(row)) {
    if (!resource.numericFields.includes(field)) {
      record[field] = value.trim();
      continue;
    }
    const text = value.trim();
    const number = Number(text);
    if (text !== '' && !Number.isFinite(number)) throw new Error(`Invalid numeric ${field}`);
    record[field] = text === '' ? null : number;
  }
  if (!lookupKey(resource, record)) throw new Error('CSV row has no search key');
  return record;
}

function shardOutputs(directory, count) {
  return Array.from({length: count}, (_, number) => {
    const path = join(directory, `${String(number).padStart(2, '0')}.jsonl.gz`);
    const gzip = createGzip();
    const file = createWriteStream(path);
    const done = pipeline(gzip, file);
    // Observe failures immediately, then await/rethrow them at completion.
    done.catch(() => {});
    return {path, gzip, file, done};
  });
}

function csvDecoder(resource, totals, digest) {
  const decoder = new TextDecoder(resource.encoding, {fatal: true});
  return new Transform({
    transform(chunk, _encoding, callback) {
      totals.bytes += chunk.length;
      digest.update(chunk);
      try { callback(null, decoder.decode(chunk, {stream: true})); }
      catch (error) { callback(error); }
    },
    flush(callback) {
      try { callback(null, decoder.decode()); }
      catch (error) { callback(error); }
    },
  });
}

async function writeRows(resource, rows, outputs, totals) {
  for await (const row of rows) {
    const record = normalizeRow(resource, row, ++totals.count);
    const key = lookupKey(resource, record);
    const output = outputs[shardNumber(key, resource.shardCount)].gzip;
    if (output.destroyed) throw new Error('Snapshot shard stream failed');
    if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
  }
}

async function finishShards(outputs) {
  for (const {gzip} of outputs) gzip.end();
  await Promise.all(outputs.map(({done}) => done));
  const sizes = await Promise.all(outputs.map(async ({path}) => (await stat(path)).size));
  const storedBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (storedBytes > MAX_STORED_BYTES) throw new Error(`Snapshot exceeds size limit: ${storedBytes}`);
  return storedBytes;
}

async function closeShards(outputs) {
  for (const {gzip, file} of outputs) {
    gzip.destroy();
    file.destroy();
  }
  await Promise.allSettled(outputs.map(({done}) => done));
}

async function buildSnapshot(resource, source, directory, {minRows = resource.minRows} = {}) {
  const outputs = shardOutputs(directory, resource.shardCount);
  const totals = {bytes: 0, count: 0};
  const digest = createHash('sha256');
  const csv = parse(csvOptions(resource));
  try {
    await pipeline(source, csvDecoder(resource, totals, digest), csv,
      (rows) => writeRows(resource, rows, outputs, totals));
    if (totals.count < minRows) throw new Error(`Snapshot has only ${totals.count} rows`);
    const storedBytes = await finishShards(outputs);
    return {...totals, storedBytes, paths: outputs.map(({path}) => path), sha256: digest.digest('hex')};
  } catch (error) {
    await closeShards(outputs);
    throw error;
  }
}

module.exports = {buildSnapshot, normalizeRow, csvOptions};

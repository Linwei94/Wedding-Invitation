// Simple JSON-file-backed store for RSVP records.
//
// Deliberately not a real database: this project can't be debugged over SSH
// on demand, so the storage layer is picked to minimize ways it can fail to
// start (no native compilation, no separate service, no credentials). A few
// hundred rows of {name, count, note, createdAt, updatedAt} does not need
// more than a JSON file with atomic writes and an in-process write queue.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rsvp.json');

function ensureFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '{}', 'utf8');
  }
}

function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    // A half-written file (e.g. after a crash mid-write) should not take the
    // whole site down; log it and treat it as empty rather than throwing.
    console.error('rsvp.json 读取/解析失败，按空数据处理：', err.message);
    return {};
  }
}

// Atomic write: write to a temp file in the same directory, then rename.
// A rename is atomic on POSIX filesystems, so readers never see a partial file.
function writeAll(obj) {
  ensureFile();
  const tmp = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

// Concurrent requests must not interleave read-modify-write cycles, so every
// mutation goes through this single promise chain.
let queue = Promise.resolve();
function serialize(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(() => {}, () => {});
  return result;
}

function upsert(name, fields) {
  return serialize(() => {
    const all = readAll();
    const key = name;
    const now = new Date().toISOString();
    const previous = all[key];
    all[key] = {
      name,
      count: fields.count,
      note: fields.note,
      attend: '出席',
      createdAt: (previous && previous.createdAt) || now,
      updatedAt: now,
    };
    writeAll(all);
    return { created: !previous };
  });
}

function listAll() {
  const all = readAll();
  return Object.values(all);
}

module.exports = { upsert, listAll };

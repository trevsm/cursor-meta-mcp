import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';

const dbPath = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
const db = new Database(dbPath, { readonly: true });
const sid = '0183a06c-9594-4fb0-95eb-89933a6869db';
const pattern = `bubbleId:${sid}:%`;

// Try both table names
let rows = [];
for (const table of ['cursorDiskKV', 'ItemTable']) {
  try {
    rows = db.prepare(`SELECT key, value FROM ${table} WHERE key LIKE ? ORDER BY rowid`).all(pattern);
    if (rows.length) {
      console.error(`Found ${rows.length} rows in ${table}`);
      break;
    }
  } catch (e) {
    console.error(`${table}: ${e.message}`);
  }
}

const suggestionRe = /Want me|next|cluster|theme|I can also|Could also|dig into|better sentiment/i;
const userRe = /I want better sentiment/i;

const assistantMatches = [];
const userMatches = [];

for (const r of rows) {
  try {
    const b = JSON.parse(r.value);
    const text = b.text || b.rawText || '';
    if (b.type === 2 && suggestionRe.test(text)) {
      assistantMatches.push({ key: r.key, text });
    }
    if (b.type === 1 && userRe.test(text)) {
      userMatches.push({ key: r.key, text });
    }
  } catch {}
}

console.error(`User matches: ${userMatches.length}, Assistant matches: ${assistantMatches.length}`);

for (const u of userMatches) {
  console.log('=== USER ===');
  console.log(u.text);
}

// Print last assistant match with suggestions (full or last 3000 chars)
if (assistantMatches.length) {
  const last = assistantMatches[assistantMatches.length - 1];
  const out = last.text.length > 3000 ? last.text.slice(-3000) : last.text;
  console.log('=== LAST ASSISTANT WITH SUGGESTIONS ===');
  console.log(out);
}

db.close();

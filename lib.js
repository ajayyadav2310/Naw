// Pure logic for MoneyTrack (no DOM, no Capacitor) so it can be unit-tested with Node.

export const DEFAULT_ACCOUNTS = ['India Post Payments Bank', 'Central Bank of India', 'Other Bank'];
export const DEFAULT_CATEGORIES = [
  'Food', 'Travel', 'Shopping', 'Rent', 'Bills', 'Education', 'Health',
  'Salary', 'Business', 'Family', 'Transfer', 'Other'
];
export const TYPES = ['income', 'expense', 'transfer'];
const MAX_DISMISSED = 3000;

export function defaultState() {
  return {
    version: 2,
    accounts: [...DEFAULT_ACCOUNTS],
    categories: [...DEFAULT_CATEGORIES],
    openingBalances: {},
    dismissed: [],
    transactions: []
  };
}

/* ---------- formatting ---------- */

export function money(n) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 2
  }).format(Number(n) || 0);
}

export const toPaise = (n) => Math.round((Number(n) || 0) * 100);
export const fromPaise = (p) => p / 100;

export function monthKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* ---------- state validation (used for load AND restore) ---------- */

function cleanString(v, max = 500) {
  return String(v ?? '').slice(0, max);
}

function uniqueStrings(list, fallback) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanString(raw, 80).trim();
    const k = s.toLowerCase();
    if (s && !seen.has(k)) { seen.add(k); out.push(s); }
  }
  return out.length ? out : [...fallback];
}

/**
 * Validates arbitrary parsed JSON and returns a safe state object.
 * Accepts the older v1 format ({accounts, transactions}).
 * Throws if the input is not recognisable as a MoneyTrack backup.
 */
export function sanitizeState(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)) {
    throw new Error('Not a MoneyTrack backup');
  }
  const accounts = uniqueStrings(data.accounts, DEFAULT_ACCOUNTS);
  const categories = uniqueStrings(data.categories, DEFAULT_CATEGORIES);

  const openingBalances = {};
  if (data.openingBalances && typeof data.openingBalances === 'object') {
    for (const a of accounts) {
      const v = Number(data.openingBalances[a]);
      if (Number.isFinite(v) && v !== 0) openingBalances[a] = v;
    }
  }

  const ids = new Set();
  const transactions = [];
  for (const t of data.transactions) {
    if (!t || typeof t !== 'object') continue;
    const type = TYPES.includes(t.type) ? t.type : null;
    const amount = Number(t.amount);
    const date = new Date(t.date);
    if (!type || !Number.isFinite(amount) || amount <= 0 || Number.isNaN(date.getTime())) continue;
    let id = cleanString(t.id, 120) || newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    const tx = {
      id,
      type,
      amount: fromPaise(toPaise(amount)),
      person: cleanString(t.person, 120),
      category: cleanString(t.category || 'Other', 80),
      account: cleanString(t.account, 80),
      method: cleanString(t.method, 40),
      date: date.toISOString(),
      notes: cleanString(t.notes, 500),
      source: cleanString(t.source || 'Manual', 20)
    };
    if (type === 'transfer') tx.toAccount = cleanString(t.toAccount, 80);
    if (t.sourceKey) tx.sourceKey = cleanString(t.sourceKey, 200);
    if (t.textHash) tx.textHash = cleanString(t.textHash, 40);
    if (t.reference) tx.reference = cleanString(t.reference, 60);
    if (Number.isFinite(Number(t.ts))) tx.ts = Number(t.ts);
    if (t.reviewed === false) tx.reviewed = false;
    transactions.push(tx);
  }

  // Make sure every account referenced by a transaction exists.
  for (const t of transactions) {
    for (const a of [t.account, t.toAccount]) {
      if (a && !accounts.some((x) => x.toLowerCase() === a.toLowerCase())) accounts.push(a);
    }
  }

  const dismissed = Array.isArray(data.dismissed)
    ? data.dismissed.map((x) => cleanString(x, 200)).filter(Boolean).slice(-MAX_DISMISSED)
    : [];

  return { version: 2, accounts, categories, openingBalances, dismissed, transactions };
}

/* ---------- calculations (integer paise to avoid float drift) ---------- */

export function sums(list) {
  let income = 0;
  let expense = 0;
  for (const t of list) {
    if (t.type === 'income') income += toPaise(t.amount);
    else if (t.type === 'expense') expense += toPaise(t.amount);
  }
  return { income: fromPaise(income), expense: fromPaise(expense) };
}

export function accountNet(state, account) {
  let total = toPaise(state.openingBalances?.[account] || 0);
  for (const t of state.transactions) {
    const p = toPaise(t.amount);
    if (t.type === 'income' && t.account === account) total += p;
    else if (t.type === 'expense' && t.account === account) total -= p;
    else if (t.type === 'transfer') {
      if (t.account === account) total -= p;
      if (t.toAccount === account) total += p;
    }
  }
  return fromPaise(total);
}

export function categoryTotals(list, type) {
  const totals = new Map();
  for (const t of list) {
    if (t.type !== type) continue;
    const key = t.category || 'Other';
    totals.set(key, (totals.get(key) || 0) + toPaise(t.amount));
  }
  return [...totals.entries()].map(([k, v]) => [k, fromPaise(v)]).sort((a, b) => b[1] - a[1]);
}

/* ---------- CSV ---------- */

export function csvCell(value) {
  let s = String(value ?? '');
  // Neutralise spreadsheet formula injection from imported SMS/notification text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildCSV(state) {
  const header = ['Date', 'Type', 'Amount INR', 'Person', 'Category', 'Account', 'Transfer To', 'Method', 'Reference', 'Notes', 'Source'];
  const rows = state.transactions.map((t) => [
    t.date, t.type, Number(t.amount).toFixed(2), t.person, t.category, t.account,
    t.toAccount || '', t.method, t.reference || '', t.notes, t.source
  ]);
  const body = [header.map(csvCell).join(',')]
    .concat(rows.map((r) => r.map((v, i) => (i === 2 ? String(v) : csvCell(v))).join(',')));
  return `﻿${body.join('\r\n')}`;
}

/* ---------- automatic import (notifications / SMS) ---------- */

export function detectAccount(raw, accounts) {
  const x = String(raw || '').toLowerCase();
  const find = (needle) => accounts.find((a) => a.toLowerCase().includes(needle));
  if (/ippb|india\s*post|ippbonline/.test(x)) return find('india post') || 'India Post Payments Bank';
  if (/\bcboi\b|\bcbi\b|central\s*bank|centralbankofindia/.test(x)) return find('central bank') || 'Central Bank of India';
  return find('other bank') || accounts[0] || 'Other Bank';
}

export function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function textHash(s) {
  const str = normalizeText(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const TEN_MIN = 10 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;

function isDuplicate(existing, c) {
  const ref = c.reference ? c.reference.toUpperCase() : '';
  for (const t of existing) {
    if (ref && t.reference && t.reference.toUpperCase() === ref) return true;
    const tts = Number.isFinite(t.ts) ? t.ts : new Date(t.date).getTime();
    if (t.textHash && t.textHash === c.textHash && Math.abs(tts - c.ts) < TEN_MIN) return true;
    // Same payment seen once as an SMS and once as a notification of that SMS.
    if (t.source && t.source !== 'Manual' && t.source !== c.source && t.type === c.type
        && t.account === c.account && toPaise(t.amount) === toPaise(c.amount)
        && Math.abs(tts - c.ts) < THREE_MIN) return true;
  }
  return false;
}

/**
 * Turns native queue items into new transactions. Pure: does not mutate `state`.
 * Returns { added: Transaction[], skipped: number }.
 */
export function planImport(state, items, sourceLabel, now = Date.now()) {
  const added = [];
  let skipped = 0;
  const working = [...state.transactions];
  const dismissed = new Set(state.dismissed || []);

  for (const item of Array.isArray(items) ? items : []) {
    const amount = Number(item?.amount);
    const direction = item?.direction;
    if (!Number.isFinite(amount) || amount <= 0 || !['income', 'expense'].includes(direction)) { skipped++; continue; }

    const raw = [item.title, item.text, item.body, item.origin, item.sender, item.packageName]
      .filter(Boolean).join(' ');
    const ts = Number(item.postedAt) || now;
    const reference = String(item.reference || '').trim();
    const account = detectAccount(raw, state.accounts);
    const hash = textHash(item.text || item.body || raw);
    const cand = {
      type: direction, amount: fromPaise(toPaise(amount)), account, source: sourceLabel,
      reference, textHash: hash, ts
    };
    const sourceKey = reference ? `REF:${reference.toUpperCase()}` : `TXT:${hash}:${Math.floor(ts / TEN_MIN)}`;
    if (dismissed.has(sourceKey) || dismissed.has(`H:${hash}`)) { skipped++; continue; }
    if (isDuplicate(working, cand)) { skipped++; continue; }

    const tx = {
      id: newId(),
      sourceKey,
      textHash: hash,
      ts,
      reviewed: false,
      type: direction,
      amount: cand.amount,
      person: cleanString(item.counterparty, 120),
      category: 'Other',
      account,
      method: 'Bank / UPI',
      date: new Date(ts).toISOString(),
      notes: cleanString(item.text || item.body || raw, 450),
      source: sourceLabel
    };
    if (reference) tx.reference = reference;
    added.push(tx);
    working.unshift(tx);
  }
  return { added, skipped };
}

/** Keys to remember when the user deletes an imported transaction, so it is not re-imported. */
export function dismissKeys(tx) {
  const keys = [];
  if (tx.sourceKey) keys.push(tx.sourceKey);
  if (tx.textHash) keys.push(`H:${tx.textHash}`);
  return keys;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultState, sanitizeState, sums, accountNet, categoryTotals, buildCSV, csvCell,
  planImport, detectAccount, dismissKeys, money, monthKey, DEFAULT_ACCOUNTS
} from '../www/lib.js';

const tx = (o) => ({ id: Math.random().toString(36), person: '', category: 'Food', account: 'Other Bank', method: 'UPI', notes: '', source: 'Manual', date: '2026-10-05T10:00:00.000Z', ...o });

test('default accounts are exactly the three required banks', () => {
  assert.deepEqual(defaultState().accounts, ['India Post Payments Bank', 'Central Bank of India', 'Other Bank']);
  assert.deepEqual(DEFAULT_ACCOUNTS.length, 3);
});

test('money formats as INR', () => {
  assert.match(money(1234.5), /₹/);
  assert.match(money(1234.5), /1,234\.50/);
  assert.match(money(1234567), /12,34,567/); // Indian digit grouping
});

test('sums avoid floating point drift', () => {
  const list = [tx({ type: 'income', amount: 0.1 }), tx({ type: 'income', amount: 0.2 }), tx({ type: 'expense', amount: 0.3 })];
  const s = sums(list);
  assert.equal(s.income, 0.3);
  assert.equal(s.expense, 0.3);
});

test('transfers move money between accounts and are excluded from income/expense', () => {
  const state = { ...defaultState(), openingBalances: { 'Other Bank': 100 } };
  state.transactions = [
    tx({ type: 'income', amount: 500, account: 'Other Bank' }),
    tx({ type: 'expense', amount: 200, account: 'Other Bank' }),
    tx({ type: 'transfer', amount: 150, account: 'Other Bank', toAccount: 'Central Bank of India', category: 'Transfer' })
  ];
  assert.equal(accountNet(state, 'Other Bank'), 100 + 500 - 200 - 150);
  assert.equal(accountNet(state, 'Central Bank of India'), 150);
  assert.deepEqual(sums(state.transactions), { income: 500, expense: 200 });
});

test('category totals only count the requested type, largest first', () => {
  const list = [tx({ type: 'expense', amount: 10, category: 'Food' }), tx({ type: 'expense', amount: 30, category: 'Rent' }),
    tx({ type: 'income', amount: 99, category: 'Salary' }), tx({ type: 'expense', amount: 5, category: 'Food' })];
  assert.deepEqual(categoryTotals(list, 'expense'), [['Rent', 30], ['Food', 15]]);
});

test('sanitizeState accepts the old v1 backup format and upgrades it', () => {
  const v1 = { accounts: ['India Post Payments Bank', 'Other Bank'], transactions: [
    { id: 'a1', type: 'expense', amount: 50, person: 'Shop', category: 'Food', account: 'Other Bank', method: 'UPI', date: '2026-10-01T00:00:00.000Z', notes: '', source: 'Manual' }] };
  const s = sanitizeState(v1);
  assert.equal(s.version, 2);
  assert.equal(s.transactions.length, 1);
  assert.ok(s.categories.includes('Food'));
});

test('sanitizeState rejects garbage and drops invalid rows', () => {
  assert.throws(() => sanitizeState(null));
  assert.throws(() => sanitizeState({ accounts: 'x', transactions: [] }));
  const s = sanitizeState({ accounts: ['A'], transactions: [
    { id: '1', type: 'expense', amount: -5, date: '2026-01-01', account: 'A' },
    { id: '2', type: 'bogus', amount: 5, date: '2026-01-01', account: 'A' },
    { id: '3', type: 'expense', amount: 5, date: 'not a date', account: 'A' },
    { id: '4', type: 'income', amount: 5, date: '2026-01-01', account: 'A' },
    { id: '4', type: 'income', amount: 7, date: '2026-01-02', account: 'A' }] });
  assert.equal(s.transactions.length, 2);
  assert.notEqual(s.transactions[0].id, s.transactions[1].id); // duplicate ids repaired
});

test('sanitizeState adds accounts referenced only by transactions', () => {
  const s = sanitizeState({ accounts: ['A'], transactions: [{ id: '1', type: 'expense', amount: 5, date: '2026-01-01', account: 'Ghost' }] });
  assert.ok(s.accounts.includes('Ghost'));
});

test('backup JSON round-trips through sanitizeState unchanged', () => {
  const state = defaultState();
  state.transactions = [tx({ id: 'x1', type: 'expense', amount: 12.34 }), tx({ id: 'x2', type: 'transfer', amount: 5, account: 'Other Bank', toAccount: 'Central Bank of India', category: 'Transfer' })];
  state.openingBalances = { 'Other Bank': 1000 };
  const round = sanitizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(round.transactions.map((t) => [t.id, t.type, t.amount, t.toAccount]), state.transactions.map((t) => [t.id, t.type, t.amount, t.toAccount]));
  assert.equal(round.openingBalances['Other Bank'], 1000);
});

test('CSV quotes values and neutralises formula injection', () => {
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+91'), `"'+91"`);
  const state = defaultState();
  state.transactions = [tx({ type: 'expense', amount: 5, notes: '=cmd|calc', person: 'Ram, Sons' })];
  const csv = buildCSV(state);
  assert.ok(csv.startsWith('﻿"Date"'));
  assert.ok(csv.includes(`"'=cmd|calc"`));
  assert.ok(csv.includes('"Ram, Sons"'));
  assert.ok(csv.includes(',5.00,'));
});

test('detectAccount maps sender/text to the right bank', () => {
  const a = DEFAULT_ACCOUNTS;
  assert.equal(detectAccount('JD-IPPBMS Rs 5 debited', a), 'India Post Payments Bank');
  assert.equal(detectAccount('AX-CBoI credited', a), 'Central Bank of India');
  assert.equal(detectAccount('Central Bank of India alert', a), 'Central Bank of India');
  assert.equal(detectAccount('HDFC alert', a), 'Other Bank');
  assert.equal(detectAccount('"abcbiz" shop', a), 'Other Bank'); // no false hit on substring "cbi"
});

const item = (o) => ({ id: 'q' + Math.random(), source: 'sms', origin: 'JD-IPPBMS', title: 'JD-IPPBMS', text: 'Rs 100 debited from IPPB a/c', amount: 100, direction: 'expense', reference: '', counterparty: 'SHOP', postedAt: Date.parse('2026-10-05T10:00:00Z'), ...o });

test('planImport creates unreviewed transactions with no fake data', () => {
  const { added } = planImport(defaultState(), [item({})], 'SMS');
  assert.equal(added.length, 1);
  assert.equal(added[0].reviewed, false);
  assert.equal(added[0].account, 'India Post Payments Bank');
  assert.equal(added[0].type, 'expense');
  assert.equal(added[0].amount, 100);
  assert.equal(added[0].person, 'SHOP');
});

test('planImport rejects invalid items', () => {
  const { added, skipped } = planImport(defaultState(), [item({ amount: 0 }), item({ direction: 'weird' }), item({ amount: 'x' }), null], 'SMS');
  assert.equal(added.length, 0);
  assert.equal(skipped, 4);
});

test('planImport de-duplicates by reference, same text, and SMS-vs-notification', () => {
  let state = defaultState();
  const first = planImport(state, [item({ reference: 'UTR12345678' })], 'SMS');
  state.transactions.unshift(...first.added);
  // same reference again (re-import of the inbox)
  assert.equal(planImport(state, [item({ reference: 'utr12345678', text: 'different text' })], 'SMS').added.length, 0);
  // exact same text again
  const s2 = defaultState();
  const a = planImport(s2, [item({})], 'SMS'); s2.transactions.unshift(...a.added);
  assert.equal(planImport(s2, [item({})], 'SMS').added.length, 0);
  // same payment seen as a notification 20s later with slightly different text
  assert.equal(planImport(s2, [item({ source: 'notification', text: 'Messages: Rs 100 debited from IPPB a/c (new)', postedAt: item({}).postedAt + 20000 })], 'Notification').added.length, 0);
  // genuinely different amount IS added
  assert.equal(planImport(s2, [item({ amount: 101, text: 'Rs 101 debited IPPB' })], 'SMS').added.length, 1);
});

test('duplicates inside one batch are collapsed', () => {
  const { added } = planImport(defaultState(), [item({}), item({})], 'SMS');
  assert.equal(added.length, 1);
});

test('deleted imported transactions are not re-imported', () => {
  const state = defaultState();
  const first = planImport(state, [item({ reference: 'REF999999' })], 'SMS');
  state.dismissed = dismissKeys(first.added[0]); // user deleted it
  // same reference, and same text without a reference: both stay dismissed
  assert.equal(planImport(state, [item({ reference: 'REF999999' })], 'SMS').added.length, 0);
  assert.equal(planImport(state, [item({ reference: '' })], 'SMS').added.length, 0);
  // an unrelated message still imports
  assert.equal(planImport(state, [item({ amount: 7, text: 'Rs 7 debited IPPB', reference: 'OTHERREF11' })], 'SMS').added.length, 1);
});

test('monthKey is stable and rejects invalid dates', () => {
  assert.equal(monthKey('invalid'), '');
  assert.match(monthKey(new Date()), /^\d{4}-\d{2}$/);
});

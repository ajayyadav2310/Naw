import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { App as CapApp } from '@capacitor/app';
import {
  DEFAULT_CATEGORIES, TYPES, defaultState, sanitizeState, money, monthKey, esc, newId,
  sums, accountNet, categoryTotals, buildCSV, planImport, dismissKeys, toPaise, fromPaise
} from './lib.js';

const Native = registerPlugin('MoneyTrackBridge');
const isNative = Capacitor.isNativePlatform();
const STORE_KEY = 'moneytrack_state_v2';
const LEGACY_KEY = 'moneytrack_v1'; // localStorage key used by earlier builds

let state = defaultState();
let currentType = 'expense';
let editingId = null;
let currentPage = 'dashboard';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ storage */

let writeChain = Promise.resolve();
function persist() {
  const json = JSON.stringify(state);
  writeChain = writeChain
    .then(() => Preferences.set({ key: STORE_KEY, value: json }))
    .catch(() => {
      try { localStorage.setItem(STORE_KEY, json); } catch (_) { /* storage unavailable */ }
    });
  return writeChain;
}

async function loadState() {
  try {
    const { value } = await Preferences.get({ key: STORE_KEY });
    if (value) return sanitizeState(JSON.parse(value));
  } catch (_) { /* fall through to legacy / default */ }
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return sanitizeState(JSON.parse(legacy)); // one-time migration from older builds
  } catch (_) { /* ignore */ }
  return defaultState();
}

/* ------------------------------------------------------------------ helpers */

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function toLocalInput(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

async function saveFile(filename, mimeType, text) {
  if (isNative) {
    try {
      const { location } = await Native.saveFile({ filename, mimeType, data: text });
      toast(`Saved to ${location}`);
      return;
    } catch (e) {
      toast('Could not save the file on this device.');
      return;
    }
  }
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ navigation */

function showPage(id) {
  currentPage = id;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === id));
  document.querySelectorAll('.bottom button').forEach((b) => b.classList.toggle('active', b.dataset.page === id));
  window.scrollTo(0, 0);
  if (id === 'dashboard') renderHome();
  if (id === 'transactions') renderTransactions();
  if (id === 'accounts') renderAccounts();
  if (id === 'reports') renderReports();
  if (id === 'settings') { renderCategories(); refreshNativeStatus(); }
}

/* ------------------------------------------------------------------ add / edit form */

function fillSelects() {
  const accountOptions = state.accounts.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
  $('account').innerHTML = accountOptions;
  $('toAccount').innerHTML = accountOptions;
  if (state.accounts.length > 1) $('toAccount').selectedIndex = 1;
  $('category').innerHTML = state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function applyFormType(type) {
  currentType = TYPES.includes(type) ? type : 'expense';
  const isTransfer = currentType === 'transfer';
  $('typeExpense').classList.toggle('selected', currentType === 'expense');
  $('typeIncome').classList.toggle('selected', currentType === 'income');
  $('typeTransfer').classList.toggle('selected', isTransfer);
  $('personLabel').textContent = currentType === 'income' ? 'Received from' : isTransfer ? 'Transfer note (optional)' : 'Paid to';
  $('person').placeholder = isTransfer ? 'e.g. Moving savings' : 'Person or business';
  $('accountLabel').textContent = isTransfer ? 'Transfer from account' : 'Account';
  $('toAccountWrap').hidden = !isTransfer;
  $('categoryWrap').hidden = isTransfer;
  $('formTitle').textContent = (editingId ? 'Edit ' : 'Add ') +
    (isTransfer ? 'account transfer' : currentType === 'income' ? 'money received' : 'money spent');
  $('deleteBtn').hidden = !editingId;
}

function openNew(type = 'expense') {
  editingId = null;
  fillSelects();
  $('person').value = '';
  $('amount').value = '';
  $('notes').value = '';
  $('date').value = nowLocal();
  applyFormType(type);
  showPage('add');
}

function openEdit(id) {
  const t = state.transactions.find((x) => x.id === id);
  if (!t) return;
  editingId = id;
  fillSelects();
  $('amount').value = t.amount;
  $('person').value = t.person || '';
  $('notes').value = t.notes || '';
  $('date').value = toLocalInput(t.date);
  $('method').value = [...$('method').options].some((o) => o.value === t.method) ? t.method : 'Other';
  if (![...$('category').options].some((o) => o.value === t.category) && t.category) {
    $('category').insertAdjacentHTML('beforeend', `<option value="${esc(t.category)}">${esc(t.category)}</option>`);
  }
  $('category').value = t.category || 'Other';
  if (![...$('account').options].some((o) => o.value === t.account)) {
    $('account').insertAdjacentHTML('beforeend', `<option value="${esc(t.account)}">${esc(t.account)}</option>`);
  }
  $('account').value = t.account;
  if (t.toAccount) $('toAccount').value = t.toAccount;
  applyFormType(t.type);
  showPage('add');
}

function saveTransaction() {
  const amount = Number($('amount').value);
  if (!Number.isFinite(amount) || amount <= 0) { toast('Enter a valid amount.'); return; }
  const dateValue = $('date').value;
  if (!dateValue) { toast('Choose date and time.'); return; }
  const account = $('account').value;
  const toAccount = $('toAccount').value;
  if (!account) { toast('Add an account first.'); return; }
  if (currentType === 'transfer' && (!toAccount || account === toAccount)) {
    toast('Choose two different accounts for a transfer.'); return;
  }
  const date = new Date(dateValue);
  const fields = {
    type: currentType,
    amount: fromPaise(toPaise(amount)),
    person: $('person').value.trim(),
    category: currentType === 'transfer' ? 'Transfer' : $('category').value,
    method: $('method').value,
    date: date.toISOString(),
    notes: $('notes').value.trim(),
    account
  };
  if (currentType === 'transfer') fields.toAccount = toAccount;

  if (editingId) {
    const index = state.transactions.findIndex((t) => t.id === editingId);
    if (index < 0) { toast('That transaction no longer exists.'); showPage('dashboard'); return; }
    const old = state.transactions[index];
    const merged = { ...old, ...fields, reviewed: true, ts: date.getTime() };
    if (currentType !== 'transfer') delete merged.toAccount;
    state.transactions[index] = merged;
    toast('Transaction updated.');
  } else {
    state.transactions.unshift({ id: newId(), ...fields, source: 'Manual', ts: date.getTime() });
    toast('Transaction saved on this device.');
  }
  editingId = null;
  persist();
  showPage('dashboard');
}

function deleteTransaction(id) {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx || !confirm('Delete this transaction?')) return false;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  if (tx.source && tx.source !== 'Manual') {
    // Remember it so the same SMS/notification is not imported again.
    state.dismissed = [...(state.dismissed || []), ...dismissKeys(tx)].slice(-3000);
  }
  persist();
  return true;
}

/* ------------------------------------------------------------------ rendering */

function txHTML(t) {
  const incoming = t.type === 'income';
  const transfer = t.type === 'transfer';
  const label = transfer ? `${esc(t.account)} → ${esc(t.toAccount)}` : `${esc(t.category)} · ${esc(t.account)}`;
  const sign = incoming ? '+' : transfer ? '⇄ ' : '−';
  const cls = incoming ? 'in' : transfer ? '' : 'out';
  const review = t.reviewed === false ? '<span class="pill warn">Review</span>' : '';
  const title = t.person || (transfer ? 'Account transfer' : t.reviewed === false ? 'Unlabelled transaction' : t.category);
  return `<div class="tx" data-action="edit" data-id="${esc(t.id)}" role="button" tabindex="0">
    <div class="txicon">${incoming ? '↙' : transfer ? '⇄' : '↗'}</div>
    <div class="txmain"><b>${esc(title)}</b>
    <small>${label} · ${fmtDate(t.date)}${review}</small></div>
    <div class="amount ${cls}">${sign}${money(t.amount)}</div>
  </div>`;
}

function renderHome() {
  const current = monthKey(new Date());
  const totals = sums(state.transactions.filter((t) => monthKey(t.date) === current));
  $('monthIncome').textContent = money(totals.income);
  $('monthExpense').textContent = money(totals.expense);
  $('netFlow').textContent = money(fromPaise(toPaise(totals.income) - toPaise(totals.expense)));
  $('accountCards').innerHTML = state.accounts.map((a) =>
    `<div class="account"><div class="bankicon">🏦</div><small>${esc(a)}</small><b>${money(accountNet(state, a))}</b></div>`
  ).join('');
  $('recentList').innerHTML = state.transactions.length
    ? state.transactions.slice(0, 5).map(txHTML).join('')
    : '<div class="empty">No transactions yet.<br>Add your first income or expense.</div>';
}

function renderTransactions() {
  const search = $('search').value.trim().toLowerCase();
  const monthSelect = $('monthFilter');
  const previous = monthSelect.value;
  const months = [...new Set(state.transactions.map((t) => monthKey(t.date)))].sort().reverse();
  monthSelect.innerHTML = '<option value="all">All months</option>' + months.map((m) => `<option value="${m}">${m}</option>`).join('');
  monthSelect.value = months.includes(previous) ? previous : 'all';
  const month = monthSelect.value;
  const type = $('typeFilter').value;
  const list = state.transactions.filter((t) => {
    if (month !== 'all' && monthKey(t.date) !== month) return false;
    if (type === 'review' ? t.reviewed !== false : (type !== 'all' && t.type !== type)) return false;
    if (!search) return true;
    const hay = [t.person, t.category, t.account, t.toAccount, t.notes, t.method, t.reference, t.amount, money(t.amount)]
      .join(' ').toLowerCase();
    return hay.includes(search);
  });
  $('allList').innerHTML = list.length
    ? list.map(txHTML).join('')
    : '<div class="empty">No matching transactions.</div>';
}

function renderAccounts() {
  $('accountList').innerHTML = state.accounts.map((a, i) => `
    <div class="card" style="margin:9px 0">
      <div class="row"><b>🏦 ${esc(a)}</b><button class="link danger" data-action="remove-account" data-index="${i}">Remove</button></div>
      <p class="muted" style="margin:9px 0 4px;font-size:11px">Recorded balance</p><b>${money(accountNet(state, a))}</b>
      <p class="muted" style="margin:12px 0 6px;font-size:11px">Opening balance (optional)</p>
      <div class="inline"><input type="number" step="0.01" inputmode="decimal" data-opening="${i}" value="${esc(state.openingBalances[a] ?? '')}" placeholder="0.00"><button class="secondary" data-action="set-opening" data-index="${i}">Save</button></div>
    </div>`).join('');
  fillSelects();
}

function barList(entries, empty) {
  if (!entries.length) return `<div class="empty">${empty}</div>`;
  const max = Math.max(...entries.map((x) => x[1]));
  return entries.map(([name, value]) =>
    `<div style="margin:12px 0"><div class="row"><span>${esc(name)}</span><b>${money(value)}</b></div><div class="bar"><i style="width:${Math.max(2, (value / max) * 100)}%"></i></div></div>`
  ).join('');
}

function renderReports() {
  const input = $('reportMonth');
  if (!input.value) input.value = monthKey(new Date());
  const list = state.transactions.filter((t) => monthKey(t.date) === input.value);
  const totals = sums(list);
  $('reportIncome').textContent = money(totals.income);
  $('reportExpense').textContent = money(totals.expense);
  $('reportNet').textContent = money(fromPaise(toPaise(totals.income) - toPaise(totals.expense)));
  $('reportCount').textContent = String(list.length);
  $('categoryReport').innerHTML = barList(categoryTotals(list, 'expense'), 'No expenses recorded for this month.');
  $('incomeReport').innerHTML = barList(categoryTotals(list, 'income'), 'No income recorded for this month.');
  $('accountReport').innerHTML = state.accounts.map((a) => {
    const own = list.filter((t) => t.account === a);
    const s = sums(own);
    return `<div class="row" style="margin:10px 0"><span>${esc(a)}</span><span><b class="in">+${money(s.income)}</b> <b class="out">−${money(s.expense)}</b></span></div>`;
  }).join('');
}

function renderCategories() {
  $('categoryChips').innerHTML = state.categories.map((c, i) =>
    `<span class="chip">${esc(c)}<button aria-label="Remove ${esc(c)}" data-action="remove-category" data-index="${i}">×</button></span>`
  ).join('');
}

/* ------------------------------------------------------------------ accounts & categories */

function addAccount() {
  const input = $('newAccount');
  const value = input.value.trim();
  if (!value) return;
  if (state.accounts.some((a) => a.toLowerCase() === value.toLowerCase())) { toast('Account already exists.'); return; }
  state.accounts.push(value);
  input.value = '';
  persist();
  renderAccounts();
}

function removeAccount(index) {
  const account = state.accounts[index];
  if (state.transactions.some((t) => t.account === account || t.toAccount === account)) {
    toast('This account has transactions. Move or delete them first.'); return;
  }
  if (state.accounts.length <= 1) { toast('Keep at least one account.'); return; }
  if (confirm(`Remove ${account}?`)) {
    state.accounts.splice(index, 1);
    delete state.openingBalances[account];
    persist();
    renderAccounts();
  }
}

function setOpening(index) {
  const account = state.accounts[index];
  const input = document.querySelector(`[data-opening="${index}"]`);
  const value = Number(input.value);
  if (input.value === '' || value === 0) delete state.openingBalances[account];
  else if (Number.isFinite(value)) state.openingBalances[account] = fromPaise(toPaise(value));
  else { toast('Enter a valid number.'); return; }
  persist();
  renderAccounts();
  toast('Opening balance saved.');
}

function addCategory() {
  const input = $('newCategory');
  const value = input.value.trim();
  if (!value) return;
  if (state.categories.some((c) => c.toLowerCase() === value.toLowerCase())) { toast('Category already exists.'); return; }
  state.categories.push(value);
  input.value = '';
  persist();
  renderCategories();
}

function removeCategory(index) {
  if (state.categories.length <= 1) { toast('Keep at least one category.'); return; }
  const name = state.categories[index];
  if (confirm(`Remove category “${name}”? Existing transactions keep their label.`)) {
    state.categories.splice(index, 1);
    persist();
    renderCategories();
  }
}

/* ------------------------------------------------------------------ export / backup / restore */

function exportCSV() { saveFile(`moneytrack-transactions-${stamp()}.csv`, 'text/csv', buildCSV(state)); }
function backupJSON() { saveFile(`moneytrack-backup-${stamp()}.json`, 'application/json', JSON.stringify(state, null, 2)); }

function restoreFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const restored = sanitizeState(JSON.parse(String(reader.result)));
      if (confirm(`Replace current data with this backup (${restored.transactions.length} transactions)?`)) {
        state = restored;
        persist();
        showPage('dashboard');
        toast('Backup restored.');
      }
    } catch (_) {
      toast('That is not a valid MoneyTrack backup file.');
    }
    $('restoreFile').value = '';
  };
  reader.onerror = () => toast('Could not read that file.');
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm('Permanently delete ALL MoneyTrack data on this device? Export a backup first if needed.')) return;
  state = defaultState();
  persist();
  showPage('dashboard');
  toast('All local data deleted.');
}

/* ------------------------------------------------------------------ native: notifications & SMS */

function setPill(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${kind}`;
}

async function refreshNativeStatus() {
  $('nativeOnly').hidden = !isNative;
  if (!isNative) return;
  try {
    const s = await Native.getStatus();
    setPill('stNotif', s.notificationAccess ? 'On' : 'Off', s.notificationAccess ? 'ok' : 'bad');
    setPill('stSms', s.smsPermission ? 'Granted' : 'Not granted', s.smsPermission ? 'ok' : 'warn');
    setPill('stBattery', s.batteryUnrestricted ? 'Unrestricted' : 'Optimised', s.batteryUnrestricted ? 'ok' : 'warn');
    setPill('stPending', String(s.pendingCount), '');
    $('nativeStatus').textContent = s.notificationAccess || s.smsPermission
      ? 'Tracking is active in the background while Android keeps the app allowed to run.'
      : 'Turn on notification access and/or the SMS permission to start automatic tracking.';
  } catch (_) {
    $('nativeStatus').textContent = 'Could not read native status.';
  }
}

async function nativeCall(fn, failMessage) {
  try { return await fn(); } catch (e) { toast(failMessage); return null; }
}

async function importItems(items, label) {
  const { added, skipped } = planImport(state, items, label);
  if (added.length) {
    state.transactions.unshift(...added);
    await persist();
  }
  return { added: added.length, skipped };
}

let syncing = false;
async function syncPending() {
  if (!isNative || syncing) return;
  syncing = true;
  try {
    const { items } = await Native.getPendingTransactions();
    if (!items || !items.length) return;
    const bySource = { sms: [], notification: [] };
    for (const item of items) (bySource[item.source] || bySource.notification).push(item);
    let added = 0;
    added += (await importItems(bySource.sms, 'SMS')).added;
    added += (await importItems(bySource.notification, 'Notification')).added;
    // Acknowledge only after everything has been saved.
    await Native.ackPendingTransactions({ ids: items.map((i) => i.id) });
    if (added) {
      toast(`${added} new transaction${added > 1 ? 's' : ''} detected. Please review.`);
      if (currentPage === 'dashboard') renderHome();
      if (currentPage === 'transactions') renderTransactions();
    }
    if (currentPage === 'settings') refreshNativeStatus();
  } catch (_) {
    // Native bridge not ready yet; retry on next tick.
  } finally {
    syncing = false;
  }
}

async function enableNotif() {
  if (!isNative) { toast('Available in the Android app only.'); return; }
  await nativeCall(() => Native.openNotificationAccessSettings(), 'Could not open Notification Access settings.');
}

async function enableSms() {
  if (!isNative) { toast('Available in the Android app only.'); return; }
  const s = await nativeCall(() => Native.requestSmsPermission(), 'Could not request SMS permission.');
  if (!s) return;
  await refreshNativeStatus();
  toast(s.smsPermission
    ? 'SMS permission granted. New bank SMS will be detected in the background.'
    : 'SMS permission not granted. If no prompt appeared, open App info → Permissions (and “Allow restricted settings” on Android 13+).');
}

async function importSms() {
  if (!isNative) { toast('SMS import works in the Android app only.'); return; }
  let status = await nativeCall(() => Native.getStatus(), 'Could not read permission status.');
  if (!status) return;
  if (!status.smsPermission) {
    status = await nativeCall(() => Native.requestSmsPermission(), 'Could not request SMS permission.');
    if (!status || !status.smsPermission) { toast('SMS permission is needed to import messages.'); refreshNativeStatus(); return; }
  }
  const days = Number($('smsDays').value) || 30;
  const result = await nativeCall(() => Native.importRecentSms({ days }), 'Could not read SMS messages.');
  if (!result) return;
  const { added, skipped } = await importItems(result.items, 'SMS');
  toast(added
    ? `${added} new transaction${added > 1 ? 's' : ''} imported (${skipped} already known or skipped). Please review.`
    : `No new bank transactions found (${result.items.length} matching message${result.items.length === 1 ? '' : 's'} already imported or ignored).`);
  refreshNativeStatus();
}

/* ------------------------------------------------------------------ events */

const actions = {
  page: (el) => showPage(el.dataset.page),
  new: (el) => openNew(el.dataset.type),
  type: (el) => { applyFormType(el.dataset.type); },
  save: () => saveTransaction(),
  'delete-current': () => { if (editingId && deleteTransaction(editingId)) { editingId = null; showPage('dashboard'); toast('Transaction deleted.'); } },
  edit: (el) => openEdit(el.dataset.id),
  'add-account': addAccount,
  'remove-account': (el) => removeAccount(Number(el.dataset.index)),
  'set-opening': (el) => setOpening(Number(el.dataset.index)),
  'add-category': addCategory,
  'remove-category': (el) => removeCategory(Number(el.dataset.index)),
  'export-csv': exportCSV,
  backup: backupJSON,
  restore: () => $('restoreFile').click(),
  'clear-all': clearAll,
  'enable-notif': enableNotif,
  'enable-sms': enableSms,
  'import-sms': importSms,
  battery: () => nativeCall(() => Native.openBatterySettings(), 'Could not open battery settings.'),
  'app-info': () => nativeCall(() => Native.openAppSettings(), 'Could not open app settings.')
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const handler = actions[el.dataset.action];
  if (handler) handler(el);
});
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('.tx[data-action]')) {
    event.preventDefault();
    actions[event.target.dataset.action](event.target);
  }
});
$('search').addEventListener('input', renderTransactions);
$('monthFilter').addEventListener('change', renderTransactions);
$('typeFilter').addEventListener('change', renderTransactions);
$('reportMonth').addEventListener('change', renderReports);
$('restoreFile').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) restoreFromFile(f); });
$('newAccount').addEventListener('keydown', (e) => { if (e.key === 'Enter') addAccount(); });
$('newCategory').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategory(); });

/* ------------------------------------------------------------------ boot */

async function boot() {
  state = await loadState();
  renderHome();
  if (!isNative) {
    $('nativeOnly').hidden = true;
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncPending(); if (currentPage === 'settings') refreshNativeStatus(); } });
  window.addEventListener('focus', () => { syncPending(); if (currentPage === 'settings') refreshNativeStatus(); });
  setInterval(() => { if (!document.hidden) syncPending(); }, 15000);

  try {
    await CapApp.addListener('backButton', () => {
      if (currentPage !== 'dashboard') { editingId = null; showPage('dashboard'); } else { CapApp.exitApp(); }
    });
  } catch (_) { /* not available in a plain browser */ }

  syncPending();
}

boot();

// Exposed for debugging / automated UI tests only; contains no secrets.
window.__moneytrack = { getState: () => state, showPage, DEFAULT_CATEGORIES };

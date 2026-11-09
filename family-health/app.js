/* Family Health — private, offline-first family health record.
 * All data lives in this browser's IndexedDB. Nothing is sent to any server.
 */
'use strict';

/* =========================================================================
 * 1. Storage (IndexedDB) + in-memory cache
 * ========================================================================= */
const DB_NAME = 'family-health-vault';
const DB_VERSION = 1;
const STORES = ['members', 'medications', 'doses', 'vitals', 'appointments', 'vaccines', 'records', 'files', 'meta'];
const CACHED = STORES.filter(s => s !== 'files'); // files hold blobs; loaded on demand
const BACKUP_FORMAT = 'family-health-backup';
const BACKUP_VERSION = 1;

let _db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(_db = req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = _db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idb = {
  all: s => tx(s, 'readonly', st => st.getAll()),
  get: (s, id) => tx(s, 'readonly', st => st.get(id)),
  put: (s, v) => tx(s, 'readwrite', st => st.put(v)),
  del: (s, id) => tx(s, 'readwrite', st => st.delete(id)),
  clear: s => tx(s, 'readwrite', st => st.clear()),
};

const S = {}; // cache: S.members, S.medications, ...
let settings = { id: 'settings' };

async function loadAll() {
  for (const s of CACHED) S[s] = await idb.all(s);
  settings = S.meta.find(m => m.id === 'settings') || { id: 'settings' };
}
async function save(store, obj) {
  if (!obj.id) obj.id = uid();
  if (!obj.createdAt) obj.createdAt = Date.now();
  obj.updatedAt = Date.now();
  await idb.put(store, obj);
  if (S[store]) {
    const i = S[store].findIndex(x => x.id === obj.id);
    if (i >= 0) S[store][i] = obj; else S[store].push(obj);
  }
  return obj;
}
async function remove(store, id) {
  await idb.del(store, id);
  if (S[store]) S[store] = S[store].filter(x => x.id !== id);
}
async function saveSettings(patch) {
  Object.assign(settings, patch);
  await save('meta', settings);
}

/* =========================================================================
 * 2. Utilities
 * ========================================================================= */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const $ = (sel, root = document) => root.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayISO = () => isoDate(new Date());
const nowLocalDT = () => { const d = new Date(); return `${isoDate(d)}T${hhmm(d)}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const toDate = s => new Date(s && s.length === 10 ? s + 'T00:00' : s);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(s, opts) {
  if (!s) return '';
  const d = toDate(s);
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString(undefined, opts || { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDT(s) {
  if (!s) return '';
  const d = toDate(s);
  if (isNaN(d)) return esc(s);
  return `${fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function relDays(iso) {
  const diff = Math.round((toDate(iso.slice(0, 10)) - toDate(todayISO())) / 864e5);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}
function ageText(dob) {
  if (!dob) return '';
  const b = toDate(dob), n = new Date();
  let months = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
  if (n.getDate() < b.getDate()) months--;
  if (months < 0) return '';
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yrs`;
}
const sortBy = (arr, key, desc) => [...arr].sort((a, b) => {
  const x = typeof key === 'function' ? key(a) : a[key], y = typeof key === 'function' ? key(b) : b[key];
  return (x > y ? 1 : x < y ? -1 : 0) * (desc ? -1 : 1);
});
const safeColor = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#0f766e');

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* =========================================================================
 * 3. Domain configuration
 * ========================================================================= */
const MEMBER_COLORS = ['#2563eb', '#db2777', '#7c3aed', '#ea580c', '#059669', '#0891b2'];
const RELATIONS = ['Self', 'Spouse', 'Daughter', 'Son', 'Parent', 'Other'];
const BLOOD_TYPES = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'];
const MED_FORMS = ['Tablet', 'Capsule', 'Syrup / liquid', 'Drops', 'Inhaler', 'Injection', 'Cream / ointment', 'Patch', 'Other'];
const RECORD_TYPES = ['Clinic visit', 'Hospital', 'Illness / symptoms', 'Lab result', 'Dental', 'Eye', 'Imaging / scan', 'Note'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const VITALS = {
  weight:  { label: 'Weight', unit: 'kg', step: '0.1' },
  height:  { label: 'Height', unit: 'cm', step: '0.1' },
  temp:    { label: 'Temperature', unit: '°C', step: '0.1', flag: v => v >= 38 ? 'Fever' : v < 35 ? 'Low' : '' },
  bp:      { label: 'Blood pressure', unit: 'mmHg', two: true, flag: (s, d) => (s >= 140 || d >= 90) ? 'High' : (s < 90 || d < 60) ? 'Low' : '' },
  hr:      { label: 'Heart rate', unit: 'bpm', step: '1' },
  glucose: { label: 'Blood glucose', unit: 'mmol/L', step: '0.1' },
  spo2:    { label: 'Oxygen (SpO₂)', unit: '%', step: '1', flag: v => v < 95 ? 'Low' : '' },
};

const member = id => S.members.find(m => m.id === id);
const firstName = m => (m?.name || '').split(' ')[0];
const membersSorted = () => {
  const order = r => Math.max(0, RELATIONS.indexOf(r));
  return sortBy(S.members, m => `${order(m.relation)}|${m.dob || '9999'}|${String(m.createdAt || 0).padStart(15, '0')}|${m.name}`);
};
const avatar = (m, cls = '') => `<span class="avatar ${cls}" style="--c:${safeColor(m.color)}">${esc(((m.name || '?').trim()[0] || '?').toUpperCase())}</span>`;
const chip = m => m ? `<span class="chip" style="--c:${safeColor(m.color)}"><span class="dot"></span>${esc(firstName(m))}</span>` : '';

/* ---------- Medication scheduling ---------- */
function medActiveOn(m, date) {
  if (m.active === false) return false;
  if (m.startDate && date < m.startDate) return false;
  if (m.endDate && date > m.endDate) return false;
  return true;
}
function doseIndex() {
  const map = new Map();
  for (const d of S.doses) map.set(d.id, d);
  return map;
}
function scheduledDoses(date, idx = doseIndex()) {
  const dow = toDate(date).getDay();
  const out = [];
  for (const m of S.medications) {
    if (m.frequency === 'prn' || !medActiveOn(m, date)) continue;
    if (m.frequency === 'days' && !(m.days || []).includes(dow)) continue;
    for (const t of m.times || []) {
      const id = `${m.id}|${date}|${t}`;
      out.push({ id, med: m, time: t, date, status: idx.get(id)?.status });
    }
  }
  return sortBy(out, d => d.time + d.med.name);
}
function scheduleText(m) {
  const times = (m.times || []).map(fmtTime).join(', ');
  if (m.frequency === 'prn') {
    const parts = ['As needed'];
    if (m.minHours) parts.push(`at least ${m.minHours} h apart`);
    if (m.maxPerDay) parts.push(`max ${m.maxPerDay}/day`);
    return parts.join(' · ');
  }
  if (m.frequency === 'days') return `${(m.days || []).map(d => DAY_NAMES[d]).join(', ')} at ${times}`;
  return `Daily at ${times}`;
}
function adherence(m, days = 7) {
  const idx = doseIndex();
  const now = new Date(), today = todayISO(), nowT = hhmm(now);
  let due = 0, taken = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(today, -i);
    for (const d of scheduledDoses(date, idx)) {
      if (d.med.id !== m.id) continue;
      if (date === today && d.time > nowT) continue;
      due++;
      if (d.status === 'taken') taken++;
    }
  }
  return due ? Math.round((taken / due) * 100) : null;
}
function prnTakenToday(m) {
  const today = todayISO();
  return sortBy(S.doses.filter(d => d.medId === m.id && d.date === today && d.status === 'taken'), 'time');
}
function prnNextAllowed(m) {
  if (!m.minHours) return null;
  const last = sortBy(S.doses.filter(d => d.medId === m.id && d.status === 'taken' && d.at), 'at', true)[0];
  if (!last) return null;
  const next = last.at + m.minHours * 3600e3;
  return next > Date.now() ? new Date(next) : null;
}
const isLowStock = m => m.active !== false && m.stock != null && m.stock <= (m.refillAt ?? 5);

/* =========================================================================
 * 4. Forms (generic modal form builder)
 * ========================================================================= */
const modal = () => $('#modal');

function fieldHTML(f, v) {
  const id = 'f_' + f.name;
  const req = f.required ? 'required' : '';
  let input;
  switch (f.type) {
    case 'textarea':
      input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(v ?? '')}</textarea>`;
      break;
    case 'select':
    case 'member': {
      const opts = f.type === 'member' ? membersSorted().map(m => [m.id, m.name]) : f.options;
      input = `<select id="${id}" name="${f.name}" ${req}>${opts.map(o => {
        const [val, txt] = Array.isArray(o) ? o : [o, o || '—'];
        return `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(txt)}</option>`;
      }).join('')}</select>`;
      break;
    }
    case 'checkbox':
      return `<div class="field" data-name="${f.name}"><label class="check"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>`;
    case 'days':
      input = `<fieldset class="days">${DAY_NAMES.map((d, i) => `<label><input type="checkbox" name="${f.name}" value="${i}" ${(v || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</fieldset>`;
      break;
    case 'tags':
    case 'times':
      input = `<input type="text" id="${id}" name="${f.name}" ${req} value="${esc((v || []).join(', '))}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
      break;
    case 'file':
      input = `<input type="file" id="${id}" name="${f.name}" multiple accept="image/*,application/pdf">`;
      break;
    case 'color':
      input = `<input type="color" id="${id}" name="${f.name}" value="${safeColor(v)}">`;
      break;
    default:
      input = `<input type="${f.type || 'text'}" id="${id}" name="${f.name}" ${req} value="${esc(v ?? '')}"
        ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
        ${f.type === 'number' ? 'inputmode="decimal"' : ''} placeholder="${esc(f.placeholder || '')}" autocomplete="off">`;
  }
  const showIf = f.showIf ? `data-showif="${esc(JSON.stringify(f.showIf))}"` : '';
  return `<div class="field" data-name="${f.name}" ${showIf}>
    <label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}
    ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>`;
}

function applyShowIf(form) {
  form.querySelectorAll('[data-showif]').forEach(wrap => {
    const { field, in: allowed } = JSON.parse(wrap.dataset.showif);
    const el = form.elements[field];
    const show = el && allowed.includes(el.value);
    wrap.hidden = !show;
    wrap.querySelectorAll('input,select,textarea').forEach(i => { i.disabled = !show; });
  });
}

function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'html') continue;
    const wrap = form.querySelector(`[data-name="${f.name}"]`);
    if (wrap?.hidden) { out[f.name] = f.type === 'days' || f.type === 'times' || f.type === 'tags' ? [] : null; continue; }
    const el = form.elements[f.name];
    switch (f.type) {
      case 'number': out[f.name] = el.value === '' ? null : Number(el.value); break;
      case 'checkbox': out[f.name] = el.checked; break;
      case 'tags': out[f.name] = el.value.split(/[,;\n]/).map(s => s.trim()).filter(Boolean); break;
      case 'times': out[f.name] = el.value.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean); break;
      case 'days': out[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map(i => +i.value); break;
      case 'file': out[f.name] = [...el.files]; break;
      default: out[f.name] = el.value.trim();
    }
  }
  return out;
}

function normalizeTimes(list) {
  const out = [];
  for (const t of list) {
    const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(t);
    if (!m || +m[1] > 23 || +m[2] > 59) return { error: `"${t}" is not a valid time. Use 24-hour format like 08:00, 20:30.` };
    out.push(`${pad(+m[1])}:${m[2]}`);
  }
  return { times: [...new Set(out)].sort() };
}

/**
 * openForm({ title, fields, values, onSave(values) => (string error | void), onDelete, submitLabel })
 */
function openForm({ title, fields, values = {}, onSave, onDelete, submitLabel = 'Save', intro = '' }) {
  const dlg = modal();
  dlg.innerHTML = `<form class="sheet" novalidate>
    <header><h2 id="modal-title">${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body">
      ${intro}
      ${fields.map(f => f.type === 'html' ? f.html : fieldHTML(f, values[f.name] ?? f.default)).join('')}
      <p class="form-error" style="color:var(--danger);margin:0;font-weight:600" hidden></p>
    </div>
    <footer>
      ${onDelete ? '<button type="button" class="btn danger" data-delete>Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn primary">${esc(submitLabel)}</button>
    </footer></form>`;
  const form = dlg.querySelector('form');
  const errEl = form.querySelector('.form-error');
  applyShowIf(form);
  form.addEventListener('change', () => applyShowIf(form));
  form.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (await onDelete() !== false) { dlg.close(); render(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const vals = readForm(form, fields);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const err = await onSave(vals);
      if (err) { errEl.textContent = err; errEl.hidden = false; return; }
      dlg.close();
      render();
    } catch (ex) {
      console.error(ex);
      errEl.textContent = 'Could not save: ' + (ex.message || ex);
      errEl.hidden = false;
    } finally { btn.disabled = false; }
  });
  dlg.showModal();
  const first = form.querySelector('.body input:not([type=checkbox]):not([disabled]), .body select, .body textarea');
  if (first && !('ontouchstart' in window)) first.focus();
}

function openSheet(title, html) {
  const dlg = modal();
  dlg.innerHTML = `<div class="sheet"><header><h2 id="modal-title">${esc(title)}</h2>
    <button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="body">${html}</div></div>`;
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.showModal();
}

/* =========================================================================
 * 5. Entity forms
 * ========================================================================= */
function needMembers() {
  if (S.members.length) return false;
  toast('Add a family member first');
  location.hash = '#/family';
  return true;
}
const defaultMember = () => currentMemberId() || membersSorted()[0]?.id;

function memberForm(existing) {
  const m = existing || { color: MEMBER_COLORS[S.members.length % MEMBER_COLORS.length], relation: S.members.length ? 'Other' : 'Self' };
  openForm({
    title: existing ? `Edit ${m.name}` : 'Add family member',
    values: m,
    fields: [
      { name: 'name', label: 'Full name', required: true },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'relation', label: 'Relation', type: 'select', options: RELATIONS },
      { name: 'sex', label: 'Sex', type: 'select', options: ['', 'Female', 'Male'] },
      { type: 'html', html: '</div><div class="field-row">' },
      { name: 'dob', label: 'Date of birth', type: 'date', max: todayISO() },
      { name: 'bloodType', label: 'Blood type', type: 'select', options: BLOOD_TYPES },
      { type: 'html', html: '</div>' },
      { name: 'allergies', label: 'Allergies', type: 'tags', placeholder: 'e.g. Penicillin, Peanuts', hint: 'Separate with commas. Shown in red on the emergency card.' },
      { name: 'conditions', label: 'Medical conditions', type: 'tags', placeholder: 'e.g. Asthma, Eczema' },
      { name: 'idNumber', label: 'IC / ID / passport no.' },
      { name: 'insurance', label: 'Insurance / panel', placeholder: 'Provider, policy no., hotline' },
      { name: 'doctor', label: 'Regular doctor / clinic', placeholder: 'Name, clinic, phone' },
      { name: 'emergencyContact', label: 'Emergency contact', placeholder: 'Name, relation, phone' },
      { name: 'notes', label: 'Other notes', type: 'textarea', placeholder: 'e.g. Organ donor, implants, special needs' },
      { name: 'color', label: 'Colour', type: 'color' },
    ],
    onSave: async v => {
      const saved = await save('members', { ...m, ...v, color: safeColor(v.color) });
      if (!existing) location.hash = `#/member/${saved.id}`;
      toast('Saved');
    },
    onDelete: existing && (async () => {
      if (!confirm(`Delete ${m.name} and ALL of their records, medications, vitals and files? This cannot be undone.`)) return false;
      await deleteMember(m.id);
      location.hash = '#/family';
      toast('Deleted');
    }),
  });
}

function medForm(existing, memberId) {
  if (needMembers()) return;
  const m = existing || { memberId: memberId || defaultMember(), frequency: 'daily', times: ['08:00'], startDate: todayISO(), form: 'Tablet', perDose: 1, active: true };
  openForm({
    title: existing ? 'Edit medication' : 'Add medication',
    values: m,
    fields: [
      { name: 'memberId', label: 'For', type: 'member', required: true },
      { name: 'name', label: 'Medicine name', required: true, placeholder: 'e.g. Paracetamol' },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'dose', label: 'Dose', placeholder: 'e.g. 500 mg / 5 ml' },
      { name: 'form', label: 'Form', type: 'select', options: MED_FORMS },
      { type: 'html', html: '</div>' },
      { name: 'purpose', label: 'Taken for', placeholder: 'e.g. Fever, Blood pressure' },
      { name: 'frequency', label: 'How often', type: 'select', options: [['daily', 'Every day'], ['days', 'Specific days of the week'], ['prn', 'Only when needed (PRN)']] },
      { name: 'days', label: 'Days', type: 'days', showIf: { field: 'frequency', in: ['days'] } },
      { name: 'times', label: 'Times (24-hour)', type: 'times', placeholder: '08:00, 20:00', hint: 'One entry per dose, separated by commas.', showIf: { field: 'frequency', in: ['daily', 'days'] } },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'minHours', label: 'Min. hours between doses', type: 'number', step: '0.5', min: 0, showIf: { field: 'frequency', in: ['prn'] } },
      { name: 'maxPerDay', label: 'Max doses per day', type: 'number', step: '1', min: 0, showIf: { field: 'frequency', in: ['prn'] } },
      { type: 'html', html: '</div>' },
      { name: 'instructions', label: 'Instructions', type: 'select', options: ['', 'Before food', 'After food', 'With food', 'Empty stomach', 'At bedtime'] },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'startDate', label: 'Start date', type: 'date' },
      { name: 'endDate', label: 'End date', type: 'date', hint: 'Leave empty if ongoing' },
      { type: 'html', html: '</div><div class="field-row">' },
      { name: 'stock', label: 'Units in stock', type: 'number', step: '0.5', min: 0, hint: 'Optional. Counts down as doses are ticked.' },
      { name: 'perDose', label: 'Units per dose', type: 'number', step: '0.5', min: 0 },
      { type: 'html', html: '</div>' },
      { name: 'refillAt', label: 'Warn me when stock falls to', type: 'number', step: '1', min: 0, placeholder: '5' },
      { name: 'prescriber', label: 'Prescribed by', placeholder: 'Doctor / clinic' },
      { name: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Side effects, how to store, etc.' },
      { name: 'active', label: 'Currently taking', type: 'checkbox' },
    ],
    onSave: async v => {
      if (v.frequency !== 'prn') {
        const r = normalizeTimes(v.times);
        if (r.error) return r.error;
        if (!r.times.length) return 'Add at least one time, e.g. 08:00.';
        v.times = r.times;
      }
      if (v.frequency === 'days' && !v.days.length) return 'Pick at least one day of the week.';
      if (v.endDate && v.startDate && v.endDate < v.startDate) return 'End date is before start date.';
      if (v.perDose == null) v.perDose = 1;
      await save('medications', { ...m, ...v });
      toast('Medication saved');
    },
    onDelete: existing && (async () => {
      if (!confirm(`Delete ${m.name} and its dose history?`)) return false;
      for (const d of S.doses.filter(d => d.medId === m.id)) await remove('doses', d.id);
      await remove('medications', m.id);
      toast('Deleted');
    }),
  });
}

function vitalForm(existing, memberId, type) {
  if (needMembers()) return;
  const v0 = existing || { memberId: memberId || defaultMember(), type: type || 'temp', at: nowLocalDT() };
  openForm({
    title: existing ? 'Edit reading' : 'Log a reading',
    values: v0,
    fields: [
      { name: 'memberId', label: 'Who', type: 'member', required: true },
      { name: 'type', label: 'Measurement', type: 'select', options: Object.entries(VITALS).map(([k, c]) => [k, `${c.label} (${c.unit})`]) },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'value', label: 'Value', type: 'number', step: 'any', required: true },
      { name: 'value2', label: 'Diastolic (lower)', type: 'number', step: '1', showIf: { field: 'type', in: ['bp'] } },
      { type: 'html', html: '</div>' },
      { name: 'at', label: 'When', type: 'datetime-local', required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, placeholder: 'e.g. after paracetamol, measured at the clinic' },
    ],
    onSave: async v => {
      if (v.type === 'bp' && v.value2 == null) return 'Enter both systolic (upper) and diastolic (lower) values.';
      await save('vitals', { ...v0, ...v });
      const cfg = VITALS[v.type];
      const flag = cfg.flag?.(v.value, v.value2);
      toast(flag ? `Saved — ${cfg.label.toLowerCase()} is ${flag.toLowerCase()}` : 'Reading saved');
    },
    onDelete: existing && (async () => { if (!confirm('Delete this reading?')) return false; await remove('vitals', v0.id); }),
  });
}

function apptForm(existing, memberId) {
  if (needMembers()) return;
  const a = existing || { memberId: memberId || defaultMember(), at: `${addDays(todayISO(), 1)}T09:00` };
  openForm({
    title: existing ? 'Edit appointment' : 'New appointment',
    values: a,
    fields: [
      { name: 'memberId', label: 'For', type: 'member', required: true },
      { name: 'title', label: 'What', required: true, placeholder: 'e.g. Follow-up, Dental check-up' },
      { name: 'at', label: 'Date & time', type: 'datetime-local', required: true },
      { name: 'provider', label: 'Doctor / clinic', placeholder: 'e.g. Dr. Aisyah, Klinik Kesihatan' },
      { name: 'location', label: 'Address / location' },
      { name: 'notes', label: 'Notes / questions to ask', type: 'textarea', placeholder: 'Bring: IC, appointment card, previous lab results…' },
      { name: 'outcome', label: 'Outcome (after the visit)', type: 'textarea', rows: 2 },
      { name: 'done', label: 'Completed', type: 'checkbox' },
    ],
    onSave: async v => { await save('appointments', { ...a, ...v }); toast('Appointment saved'); },
    onDelete: existing && (async () => { if (!confirm('Delete this appointment?')) return false; await remove('appointments', a.id); }),
  });
}

function vaccineForm(existing, memberId) {
  if (needMembers()) return;
  const v0 = existing || { memberId: memberId || defaultMember(), date: todayISO() };
  openForm({
    title: existing ? 'Edit vaccination' : 'Add vaccination',
    values: v0,
    fields: [
      { name: 'memberId', label: 'Who', type: 'member', required: true },
      { name: 'name', label: 'Vaccine', required: true, placeholder: 'e.g. MMR, HPV, Influenza, COVID-19' },
      { name: 'doseLabel', label: 'Dose', placeholder: 'e.g. Dose 1, Booster' },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'date', label: 'Date given', type: 'date' },
      { name: 'nextDue', label: 'Next dose due', type: 'date' },
      { type: 'html', html: '</div>' },
      { name: 'provider', label: 'Given at', placeholder: 'Clinic / school programme' },
      { name: 'batch', label: 'Batch / lot no.' },
      { name: 'notes', label: 'Notes / reactions', type: 'textarea', rows: 2 },
    ],
    onSave: async v => { await save('vaccines', { ...v0, ...v }); toast('Vaccination saved'); },
    onDelete: existing && (async () => { if (!confirm('Delete this vaccination?')) return false; await remove('vaccines', v0.id); }),
  });
}

function recordForm(existing, memberId) {
  if (needMembers()) return;
  const r = existing || { memberId: memberId || defaultMember(), date: todayISO(), type: 'Clinic visit', attachments: [] };
  openForm({
    title: existing ? 'Edit record' : 'Add health record',
    values: r,
    fields: [
      { name: 'memberId', label: 'Who', type: 'member', required: true },
      { type: 'html', html: '<div class="field-row">' },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'type', label: 'Type', type: 'select', options: RECORD_TYPES },
      { type: 'html', html: '</div>' },
      { name: 'title', label: 'Title', required: true, placeholder: 'e.g. Fever & sore throat, Blood test' },
      { name: 'provider', label: 'Doctor / clinic' },
      { name: 'diagnosis', label: 'Diagnosis / result' },
      { name: 'details', label: 'Details', type: 'textarea', rows: 4, placeholder: 'Symptoms, what the doctor said, treatment, MC days…' },
      { name: 'files', label: 'Attach photos / PDFs', type: 'file', hint: 'Prescriptions, lab reports, MC, X-rays. Photos are resized to save space.' },
    ],
    onSave: async v => {
      const files = v.files; delete v.files;
      const attachments = [...(r.attachments || [])];
      for (const f of files) attachments.push(await storeFile(f));
      await save('records', { ...r, ...v, attachments });
      toast('Record saved');
    },
    onDelete: existing && (async () => {
      if (!confirm('Delete this record and its attachments?')) return false;
      for (const a of r.attachments || []) await idb.del('files', a.id);
      await remove('records', r.id);
    }),
  });
}

/* ---------- Files ---------- */
async function shrinkImage(file, maxDim = 2000, quality = 0.85) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', quality));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
async function storeFile(file) {
  const f = await shrinkImage(file);
  const rec = { id: uid(), blob: f, name: f.name, type: f.type, size: f.size, createdAt: Date.now() };
  await idb.put('files', rec);
  return { id: rec.id, name: rec.name, type: rec.type, size: rec.size };
}
const fileURLs = new Map();
async function fileURL(id) {
  if (fileURLs.has(id)) return fileURLs.get(id);
  const rec = await idb.get('files', id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  fileURLs.set(id, url);
  return url;
}
async function hydrateThumbs() {
  for (const el of document.querySelectorAll('.thumb[data-img]')) {
    const url = await fileURL(el.dataset.id);
    if (url) { el.style.backgroundImage = `url("${url}")`; el.classList.add('has-img'); }
  }
}

async function deleteMember(id) {
  for (const store of ['medications', 'doses', 'vitals', 'appointments', 'vaccines', 'records']) {
    for (const x of S[store].filter(x => x.memberId === id)) {
      if (store === 'records') for (const a of x.attachments || []) await idb.del('files', a.id);
      await remove(store, x.id);
    }
  }
  await remove('members', id);
}

/* =========================================================================
 * 6. Dose actions
 * ========================================================================= */
async function adjustStock(med, delta) {
  if (med.stock == null) return;
  med.stock = Math.max(0, Math.round((med.stock + delta) * 100) / 100);
  await save('medications', med);
}
async function setDose(id, status) {
  const [medId, date, time] = id.split('|');
  const med = S.medications.find(m => m.id === medId);
  if (!med) return;
  const prev = S.doses.find(d => d.id === id);
  const per = med.perDose ?? 1;
  if (prev && prev.status === status) {           // tap again = undo
    await remove('doses', id);
    if (status === 'taken') await adjustStock(med, +per);
  } else {
    await save('doses', { id, medId, memberId: med.memberId, date, time, status, at: Date.now() });
    if (status === 'taken' && prev?.status !== 'taken') await adjustStock(med, -per);
    if (status !== 'taken' && prev?.status === 'taken') await adjustStock(med, +per);
  }
  render();
}
async function logPrn(medId) {
  const med = S.medications.find(m => m.id === medId);
  const taken = prnTakenToday(med).length;
  if (med.maxPerDay && taken >= med.maxPerDay && !confirm(`${med.name}: already ${taken} dose(s) today (max ${med.maxPerDay}). Log another anyway?`)) return;
  const next = prnNextAllowed(med);
  if (next && !confirm(`${med.name}: the minimum gap of ${med.minHours} h is not over until ${next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Log anyway?`)) return;
  const now = new Date();
  await save('doses', { id: uid(), medId, memberId: med.memberId, date: isoDate(now), time: hhmm(now), status: 'taken', prn: true, at: now.getTime() });
  await adjustStock(med, -(med.perDose ?? 1));
  toast(`${med.name} logged at ${fmtTime(hhmm(now))}`);
  render();
}
async function undoPrn(doseId) {
  const d = S.doses.find(x => x.id === doseId);
  const med = S.medications.find(m => m.id === d?.medId);
  if (!d || !confirm('Remove this logged dose?')) return;
  await remove('doses', d.id);
  if (med) await adjustStock(med, +(med.perDose ?? 1));
  render();
}

/* =========================================================================
 * 7. Calendar export (.ics) — the most reliable way to get phone alarms
 * ========================================================================= */
const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
const icsDT = s => s.replace(/[-:]/g, '').slice(0, 13) + '00'; // YYYYMMDDTHHMM00 (floating local time)
function icsStamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); }
function icsWrap(events) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Health//EN', 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR'].join('\r\n');
}
function apptICS(a) {
  const m = member(a.memberId);
  return icsWrap([
    'BEGIN:VEVENT', `UID:${a.id}@family-health`, `DTSTAMP:${icsStamp()}`,
    `DTSTART:${icsDT(a.at)}`, 'DURATION:PT1H',
    `SUMMARY:${icsEsc(`${firstName(m)}: ${a.title}`)}`,
    a.location || a.provider ? `LOCATION:${icsEsc([a.provider, a.location].filter(Boolean).join(', '))}` : '',
    a.notes ? `DESCRIPTION:${icsEsc(a.notes)}` : '',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'DESCRIPTION:Appointment tomorrow', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT1H', 'DESCRIPTION:Appointment in 1 hour', 'END:VALARM',
    'END:VEVENT',
  ].filter(Boolean));
}
function medICS(med) {
  const m = member(med.memberId);
  const start = med.startDate && med.startDate > todayISO() ? med.startDate : todayISO();
  const byday = med.frequency === 'days' ? `;BYDAY=${(med.days || []).map(d => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d]).join(',')}` : '';
  const until = med.endDate ? `;UNTIL=${med.endDate.replace(/-/g, '')}T235900` : '';
  const freq = med.frequency === 'days' ? 'WEEKLY' : 'DAILY';
  return icsWrap((med.times || []).flatMap(t => [
    'BEGIN:VEVENT', `UID:${med.id}-${t.replace(':', '')}@family-health`, `DTSTAMP:${icsStamp()}`,
    `DTSTART:${icsDT(`${start}T${t}`)}`, 'DURATION:PT5M',
    `RRULE:FREQ=${freq}${byday}${until}`,
    `SUMMARY:${icsEsc(`💊 ${firstName(m)}: ${med.name}${med.dose ? ' ' + med.dose : ''}`)}`,
    `DESCRIPTION:${icsEsc([med.instructions, med.purpose && 'For: ' + med.purpose].filter(Boolean).join('\n'))}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', `DESCRIPTION:${icsEsc(med.name)}`, 'END:VALARM',
    'END:VEVENT',
  ]));
}
const fileSafe = s => String(s).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'event';

/* =========================================================================
 * 8. Views
 * ========================================================================= */
let ui = { medsFilter: 'all', visitsFilter: 'all', showPastMeds: false, vitalType: null };

function currentRoute() {
  const [page = 'today', a, b] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: page || 'today', a: a && decodeURIComponent(a), b };
}
function currentMemberId() {
  const r = currentRoute();
  return r.page === 'member' ? r.a : null;
}

function memberPills(filterKey) {
  if (S.members.length < 2) return '';
  const cur = ui[filterKey];
  return `<div class="pills" role="tablist">
    <button class="pill ${cur === 'all' ? 'active' : ''}" data-action="filter" data-key="${filterKey}" data-val="all">Everyone</button>
    ${membersSorted().map(m => `<button class="pill ${cur === m.id ? 'active' : ''}" style="--c:${safeColor(m.color)}" data-action="filter" data-key="${filterKey}" data-val="${m.id}">${esc(firstName(m))}</button>`).join('')}
  </div>`;
}

/* ---------- Today ---------- */
function viewToday() {
  const now = new Date(), today = todayISO(), nowT = hhmm(now);
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  let html = `<div class="spread"><div><h1>${greeting}</h1><div class="muted">${fmtDate(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div></div>`;

  if (!S.members.length) {
    return html + `<div class="card section stack">
      <h2>Welcome 👋</h2>
      <p style="margin:0">Keep your family's health in one private place: medications with daily reminders, temperature and growth readings, doctor visits, vaccinations and an emergency card for each person.</p>
      <p class="muted" style="margin:0">Everything is stored only on this device. Nothing is uploaded.</p>
      <button class="btn primary" data-action="quickStart">Set up my family (me, wife, 2 daughters)</button>
      <button class="btn" data-action="addMember">Add members one by one</button>
      <button class="btn ghost" data-action="goto" data-href="#/settings">Restore from a backup</button>
    </div>`;
  }

  // ---- Alerts ----
  const alerts = [];
  const lowMeds = S.medications.filter(isLowStock);
  for (const m of lowMeds) alerts.push(`<div class="card alert-warn flat"><div class="spread"><div>${chip(member(m.memberId))} <strong>${esc(m.name)}</strong> is running low — ${m.stock} left.</div><button class="btn small" data-action="editMed" data-id="${m.id}">Update</button></div></div>`);
  const dueVax = sortBy(S.vaccines.filter(v => v.nextDue && v.nextDue <= addDays(today, 30) && !S.vaccines.some(o => o !== v && o.memberId === v.memberId && o.name.toLowerCase() === v.name.toLowerCase() && o.date && o.date >= v.nextDue)), 'nextDue');
  for (const v of dueVax) alerts.push(`<div class="card ${v.nextDue < today ? 'alert-danger' : 'alert-warn'} flat">${chip(member(v.memberId))} <strong>${esc(v.name)}</strong> vaccine ${v.nextDue < today ? 'was due' : 'is due'} ${relDays(v.nextDue)} (${fmtDate(v.nextDue)}).</div>`);
  const recentFever = S.vitals.filter(v => v.type === 'temp' && v.value >= 38 && Date.now() - toDate(v.at) < 48 * 3600e3);
  const feverMembers = [...new Set(recentFever.map(v => v.memberId))];
  for (const id of feverMembers) {
    const last = sortBy(S.vitals.filter(v => v.memberId === id && v.type === 'temp'), 'at', true)[0];
    if (last && last.value >= 38) alerts.push(`<div class="card alert-danger flat"><div class="spread"><div>${chip(member(id))} latest temperature <strong>${last.value} °C</strong> (${fmtDT(last.at)}).</div><button class="btn small" data-action="addVital" data-member="${id}" data-type="temp">Re-check</button></div></div>`);
  }
  const hasData = S.members.length && (S.medications.length + S.records.length + S.vitals.length) > 0;
  const lastBackup = settings.lastBackup;
  if (hasData && (!lastBackup || Date.now() - lastBackup > 30 * 864e5)) {
    alerts.push(`<div class="card alert-warn flat"><div class="spread"><div>💾 ${lastBackup ? `Last backup was ${relDays(isoDate(new Date(lastBackup)))}.` : 'You have never backed up.'} Data on a phone can be lost.</div><button class="btn small" data-action="goto" data-href="#/settings">Back up</button></div></div>`);
  }
  if (alerts.length) html += `<div class="section stack">${alerts.join('')}</div>`;

  // ---- Today's medicines ----
  const doses = scheduledDoses(today);
  const prn = S.medications.filter(m => m.frequency === 'prn' && medActiveOn(m, today));
  html += `<div class="section"><div class="spread"><span class="section-title">Today's medicines</span>
    ${doses.length ? `<span class="badge ${doses.every(d => d.status) ? 'ok' : ''}">${doses.filter(d => d.status === 'taken').length}/${doses.length} taken</span>` : ''}</div>`;
  if (!doses.length && !prn.length) {
    html += `<div class="empty">No medicines scheduled today.<br><button class="btn small" style="margin-top:10px" data-action="addMed">Add a medication</button></div>`;
  } else {
    for (const m of membersSorted()) {
      const md = doses.filter(d => d.med.memberId === m.id);
      const mp = prn.filter(p => p.memberId === m.id);
      if (!md.length && !mp.length) continue;
      html += `<div class="card tinted" style="--c:${safeColor(m.color)}"><div class="row" style="margin-bottom:4px">${chip(m)}</div>`;
      for (const d of md) {
        const overdue = !d.status && d.time < nowT;
        html += `<div class="dose ${d.status || ''} ${overdue ? 'overdue' : ''}">
          <div class="dose-time">${esc(d.time)}</div>
          <div class="grow"><div class="dose-name"><strong>${esc(d.med.name)}</strong> ${esc(d.med.dose || '')}</div>
            <small>${esc([d.med.instructions, d.status === 'skipped' ? 'Skipped' : overdue ? 'Overdue' : ''].filter(Boolean).join(' · '))}</small></div>
          <div class="dose-actions">
            <button class="skip-btn ${d.status === 'skipped' ? 'on' : ''}" data-action="dose" data-id="${esc(d.id)}" data-status="skipped">${d.status === 'skipped' ? 'Skipped' : 'Skip'}</button>
            <button class="check-btn ${d.status === 'taken' ? 'on' : ''}" data-action="dose" data-id="${esc(d.id)}" data-status="taken" aria-label="Mark ${esc(d.med.name)} taken" aria-pressed="${d.status === 'taken'}">✓</button>
          </div></div>`;
      }
      for (const p of mp) {
        const taken = prnTakenToday(p);
        const next = prnNextAllowed(p);
        html += `<div class="dose"><div class="dose-time">PRN</div>
          <div class="grow"><div><strong>${esc(p.name)}</strong> ${esc(p.dose || '')}</div>
            <small>${taken.length ? `Today: ${taken.map(t => `<a href="#" data-action="undoPrn" data-id="${t.id}">${esc(t.time)}</a>`).join(', ')}` : 'Not taken today'}${p.maxPerDay ? ` · max ${p.maxPerDay}/day` : ''}${next ? ` · next from ${next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}</small></div>
          <div class="dose-actions"><button class="btn small" data-action="prn" data-id="${p.id}">Log dose</button></div></div>`;
      }
      html += `</div>`;
    }
  }
  html += `</div>`;

  // ---- Upcoming appointments ----
  const upcoming = sortBy(S.appointments.filter(a => !a.done && a.at >= `${today}T00:00` && a.at <= `${addDays(today, 14)}T23:59`), 'at');
  html += `<div class="section"><div class="spread"><span class="section-title">Next 14 days</span><a href="#/visits" class="btn small ghost">All visits</a></div>`;
  html += upcoming.length ? upcoming.map(apptCard).join('') : `<div class="empty">No appointments in the next two weeks.</div>`;
  html += `</div>`;

  // ---- Family quick view ----
  html += `<div class="section"><div class="spread"><span class="section-title">Family</span></div><div class="stat-grid">`;
  for (const m of membersSorted()) {
    html += `<a class="stat card link flat" href="#/member/${m.id}"><div class="row">${avatar(m)}<div class="grow"><strong>${esc(firstName(m))}</strong><br><small>${esc(ageText(m.dob))}</small></div></div></a>`;
  }
  html += `</div></div>`;
  return html;
}

/* ---------- Family ---------- */
function viewFamily() {
  let html = `<div class="spread"><h1>Family</h1><button class="btn primary" data-action="addMember">+ Member</button></div><div class="section">`;
  if (!S.members.length) return html + `<div class="empty">No family members yet.<br><br><button class="btn primary" data-action="quickStart">Set up my family (me, wife, 2 daughters)</button></div></div>`;
  for (const m of membersSorted()) {
    const meds = S.medications.filter(x => x.memberId === m.id && medActiveOn(x, todayISO()));
    const next = sortBy(S.appointments.filter(a => a.memberId === m.id && !a.done && a.at >= nowLocalDT()), 'at')[0];
    html += `<a class="card link tinted" style="--c:${safeColor(m.color)}" href="#/member/${m.id}">
      <div class="row">${avatar(m)}<div class="grow">
        <h3>${esc(m.name)}</h3>
        <small>${esc([m.relation, ageText(m.dob), m.bloodType && 'Blood ' + m.bloodType].filter(Boolean).join(' · '))}</small>
        <div class="row wrap" style="margin-top:6px;gap:6px">
          ${(m.allergies || []).map(a => `<span class="badge danger">⚠ ${esc(a)}</span>`).join('')}
          ${(m.conditions || []).map(c => `<span class="badge">${esc(c)}</span>`).join('')}
          ${meds.length ? `<span class="badge primary">${meds.length} active med${meds.length > 1 ? 's' : ''}</span>` : ''}
          ${next ? `<span class="badge warn">📅 ${esc(relDays(next.at))}</span>` : ''}
        </div></div></div></a>`;
  }
  return html + '</div>';
}

/* ---------- Member detail ---------- */
const MEMBER_TABS = [['overview', 'Overview'], ['meds', 'Medications'], ['vitals', 'Readings'], ['history', 'History'], ['vaccines', 'Vaccines'], ['visits', 'Visits']];

function viewMember(id, tab = 'overview') {
  const m = member(id);
  if (!m) return `<div class="empty">Member not found. <a href="#/family">Back to family</a></div>`;
  let html = `<div class="card"><div class="row">${avatar(m, 'lg')}<div class="grow">
      <h1>${esc(m.name)}</h1>
      <div class="muted">${esc([m.relation, ageText(m.dob), m.dob && `born ${fmtDate(m.dob)}`].filter(Boolean).join(' · '))}</div></div></div>
    <div class="row wrap" style="margin-top:12px">
      <button class="btn small" data-action="editMember" data-id="${m.id}">Edit profile</button>
      <a class="btn small danger" href="#/emergency/${m.id}">🚑 Emergency card</a>
    </div></div>
    <nav class="tabs">${MEMBER_TABS.map(([k, l]) => `<a href="#/member/${m.id}/${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</nav>`;

  switch (tab) {
    case 'meds': html += memberMeds(m); break;
    case 'vitals': html += memberVitals(m); break;
    case 'history': html += memberHistory(m); break;
    case 'vaccines': html += memberVaccines(m); break;
    case 'visits': html += memberVisits(m); break;
    default: html += memberOverview(m);
  }
  return html;
}

function memberOverview(m) {
  const kv = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  let html = `<div class="card"><dl class="kv">
    ${kv('Blood type', esc(m.bloodType))}
    ${kv('Allergies', (m.allergies || []).length ? `<span style="color:var(--danger);font-weight:700">${esc(m.allergies.join(', '))}</span>` : '<span class="muted">None recorded</span>')}
    ${kv('Conditions', esc((m.conditions || []).join(', ')))}
    ${kv('Sex', esc(m.sex))}
    ${kv('IC / ID', esc(m.idNumber))}
    ${kv('Insurance', esc(m.insurance))}
    ${kv('Doctor', esc(m.doctor))}
    ${kv('Emergency', esc(m.emergencyContact))}
    ${kv('Notes', esc(m.notes))}
  </dl></div>`;

  // Latest readings
  const latest = Object.keys(VITALS).map(t => sortBy(S.vitals.filter(v => v.memberId === m.id && v.type === t), 'at', true)[0]).filter(Boolean);
  html += `<div class="section"><div class="spread"><span class="section-title">Latest readings</span><button class="btn small" data-action="addVital" data-member="${m.id}">+ Reading</button></div>`;
  html += latest.length ? `<div class="stat-grid">${latest.map(v => statTile(v)).join('')}</div>` : `<div class="empty">No readings yet.</div>`;
  html += `</div>`;

  const meds = S.medications.filter(x => x.memberId === m.id && medActiveOn(x, todayISO()));
  html += `<div class="section"><div class="spread"><span class="section-title">Current medications</span><a class="btn small ghost" href="#/member/${m.id}/meds">Manage</a></div>`;
  html += meds.length ? `<div class="card">${meds.map(x => `<div class="dose"><div class="grow"><strong>${esc(x.name)}</strong> ${esc(x.dose || '')}<br><small>${esc(scheduleText(x))}</small></div></div>`).join('')}</div>` : `<div class="empty">No current medications.</div>`;
  html += `</div>`;

  const recent = sortBy(S.records.filter(r => r.memberId === m.id), 'date', true).slice(0, 3);
  if (recent.length) html += `<div class="section"><div class="spread"><span class="section-title">Recent history</span><a class="btn small ghost" href="#/member/${m.id}/history">All</a></div>${recent.map(recordCard).join('')}</div>`;
  return html;
}

function statTile(v) {
  const c = VITALS[v.type];
  const flag = c.flag?.(v.value, v.value2);
  const val = c.two ? `${v.value}/${v.value2}` : v.value;
  return `<button class="stat" style="text-align:left;font:inherit;color:inherit;cursor:pointer" data-action="editVital" data-id="${v.id}">
    <div class="label">${esc(c.label)} ${flag ? `<span class="badge ${flag === 'Fever' || flag === 'High' ? 'danger' : 'warn'}">${flag}</span>` : ''}</div>
    <div class="value">${esc(val)} <small>${esc(c.unit)}</small></div>
    <small>${esc(relDays(v.at))}</small></button>`;
}

function medCard(x, showMember) {
  const adh = x.frequency !== 'prn' ? adherence(x) : null;
  const low = isLowStock(x);
  const active = medActiveOn(x, todayISO());
  return `<div class="card ${showMember ? 'tinted' : ''}" style="--c:${safeColor(member(x.memberId)?.color)}">
    <div class="spread"><div class="grow">
      ${showMember ? chip(member(x.memberId)) + ' ' : ''}<h3 style="display:inline">${esc(x.name)}</h3> <span class="muted">${esc([x.dose, x.form].filter(Boolean).join(' · '))}</span>
      ${!active ? ' <span class="badge">Stopped</span>' : ''}
      <div><small>${esc(scheduleText(x))}${x.instructions ? ' · ' + esc(x.instructions) : ''}</small></div>
      ${x.purpose ? `<div><small>For: ${esc(x.purpose)}</small></div>` : ''}
      ${x.endDate ? `<div><small>Until ${fmtDate(x.endDate)}</small></div>` : ''}
    </div></div>
    ${x.stock != null ? `<div style="margin-top:8px"><small>${low ? '⚠ ' : ''}${x.stock} left${low ? ' — time to refill' : ''}</small></div>` : ''}
    ${adh != null && active ? `<div style="margin-top:6px"><small>Taken on time, last 7 days: <strong>${adh}%</strong></small><div class="meter ${adh < 50 ? 'danger' : adh < 80 ? 'warn' : ''}"><span style="width:${adh}%"></span></div></div>` : ''}
    <div class="row wrap" style="margin-top:10px">
      <button class="btn small" data-action="editMed" data-id="${x.id}">Edit</button>
      ${x.frequency !== 'prn' && active ? `<button class="btn small" data-action="medICS" data-id="${x.id}">📅 Phone reminders</button>` : ''}
      ${x.frequency === 'prn' && active ? `<button class="btn small" data-action="prn" data-id="${x.id}">Log dose</button>` : ''}
    </div></div>`;
}

function memberMeds(m) {
  const all = S.medications.filter(x => x.memberId === m.id);
  const cur = sortBy(all.filter(x => medActiveOn(x, todayISO())), 'name');
  const past = sortBy(all.filter(x => !medActiveOn(x, todayISO())), 'updatedAt', true);
  let html = `<div class="spread"><span class="section-title">Current</span><button class="btn small primary" data-action="addMed" data-member="${m.id}">+ Medication</button></div><div style="margin-top:10px">`;
  html += cur.length ? cur.map(x => medCard(x)).join('') : `<div class="empty">No current medications.</div>`;
  html += `</div>`;
  if (past.length) html += `<div class="section"><span class="section-title">Past / stopped</span><div style="margin-top:10px">${past.map(x => medCard(x)).join('')}</div></div>`;
  return html;
}

function memberVitals(m) {
  const mine = S.vitals.filter(v => v.memberId === m.id);
  const typesWithData = Object.keys(VITALS).filter(t => mine.some(v => v.type === t));
  let type = ui.vitalType && VITALS[ui.vitalType] ? ui.vitalType : (typesWithData[0] || 'temp');
  let html = `<div class="spread"><div class="pills">${Object.entries(VITALS).map(([k, c]) =>
    `<button class="pill ${k === type ? 'active' : ''}" data-action="vitalType" data-type="${k}">${esc(c.label)}${typesWithData.includes(k) ? '' : ' ·'}</button>`).join('')}</div></div>`;
  const list = sortBy(mine.filter(v => v.type === type), 'at');
  const c = VITALS[type];
  html += `<div class="section"><div class="spread"><span class="section-title">${esc(c.label)} (${esc(c.unit)})</span>
    <button class="btn small primary" data-action="addVital" data-member="${m.id}" data-type="${type}">+ Reading</button></div>`;
  if (list.length >= 2) html += `<div class="card">${lineChart(list.slice(-30), c)}</div>`;
  if (!list.length) html += `<div class="empty">No ${esc(c.label.toLowerCase())} readings yet.${type === 'height' || type === 'weight' ? '<br><small>Tip: record the girls\' height & weight every few months to see their growth curve.</small>' : ''}</div>`;
  else {
    html += `<div class="card" style="margin-top:10px">${[...list].reverse().map(v => {
      const flag = c.flag?.(v.value, v.value2);
      return `<div class="dose" style="cursor:pointer" data-action="editVital" data-id="${v.id}">
        <div class="grow"><strong>${esc(c.two ? `${v.value}/${v.value2}` : v.value)} ${esc(c.unit)}</strong>
          ${flag ? `<span class="badge ${flag === 'Low' ? 'warn' : 'danger'}">${flag}</span>` : ''}
          ${v.notes ? `<br><small>${esc(v.notes)}</small>` : ''}</div>
        <small>${fmtDT(v.at)}</small></div>`;
    }).join('')}</div>`;
  }
  return html + `</div>`;
}

function lineChart(list, cfg) {
  const W = 600, H = 260, P = { l: 62, r: 14, t: 16, b: 40 };
  const xs = list.map(v => toDate(v.at).getTime());
  const vals = list.flatMap(v => cfg.two ? [v.value, v.value2] : [v.value]).filter(v => v != null);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const padV = (max - min) * 0.12; min -= padV; max += padV;
  const x0 = Math.min(...xs), x1 = Math.max(...xs) === x0 ? x0 + 1 : Math.max(...xs);
  const X = t => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = v => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map(f => min + f * (max - min));
  const dec = max - min < 5 ? 1 : 0;
  const line = (key, cls) => {
    const pts = list.filter(v => v[key] != null).map(v => [X(toDate(v.at).getTime()), Y(v[key])]);
    return `<polyline class="l${cls}" points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}"/>` +
      pts.map(([x, y]) => `<circle class="p${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6"/>`).join('');
  };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.label)} chart">
    ${ticks.map(v => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${P.l - 8}" y="${Y(v) + 6}" text-anchor="end">${v.toFixed(dec)}</text>`).join('')}
    <text class="axis" x="${P.l}" y="${H - 10}">${esc(fmtDate(list[0].at))}</text>
    <text class="axis" x="${W - P.r}" y="${H - 10}" text-anchor="end">${esc(fmtDate(list[list.length - 1].at))}</text>
    ${line('value', 1)}${cfg.two ? line('value2', 2) : ''}
  </svg>`;
}

function recordCard(r) {
  return `<div class="card">
    <div class="spread"><div class="grow">
      <small>${fmtDate(r.date)} · ${esc(r.type)}${r.provider ? ' · ' + esc(r.provider) : ''}</small>
      <h3>${esc(r.title)}</h3>
      ${r.diagnosis ? `<div><strong>${esc(r.diagnosis)}</strong></div>` : ''}
    </div><button class="btn small" data-action="editRecord" data-id="${r.id}">Edit</button></div>
    ${r.details ? `<p class="prewrap" style="margin:8px 0 0">${esc(r.details)}</p>` : ''}
    ${(r.attachments || []).length ? `<div class="thumbs">${r.attachments.map(a => `
      <div class="thumb" ${a.type?.startsWith('image/') ? 'data-img' : ''} data-id="${a.id}" data-action="openFile" role="button" tabindex="0" title="${esc(a.name)}">
        ${a.type === 'application/pdf' ? '📄 ' : ''}${esc(a.name)}
        <button class="x" data-action="delAttachment" data-record="${r.id}" data-id="${a.id}" aria-label="Remove attachment">×</button>
      </div>`).join('')}</div>` : ''}
  </div>`;
}

function memberHistory(m) {
  const recs = sortBy(S.records.filter(r => r.memberId === m.id), 'date', true);
  return `<div class="spread"><span class="section-title">Health records</span><button class="btn small primary" data-action="addRecord" data-member="${m.id}">+ Record</button></div>
    <div style="margin-top:10px">${recs.length ? recs.map(recordCard).join('') : `<div class="empty">Record clinic visits, illnesses, lab results and attach photos of prescriptions or reports.</div>`}</div>`;
}

function memberVaccines(m) {
  const vs = sortBy(S.vaccines.filter(v => v.memberId === m.id), v => v.date || v.nextDue || '', true);
  const today = todayISO();
  return `<div class="spread"><span class="section-title">Vaccinations</span><button class="btn small primary" data-action="addVaccine" data-member="${m.id}">+ Vaccine</button></div>
    <div style="margin-top:10px">${vs.length ? `<div class="card">${vs.map(v => `
      <div class="dose" style="cursor:pointer" data-action="editVaccine" data-id="${v.id}">
        <div class="grow"><strong>${esc(v.name)}</strong> ${v.doseLabel ? `<span class="muted">${esc(v.doseLabel)}</span>` : ''}
          <br><small>${v.date ? 'Given ' + fmtDate(v.date) : 'Not yet given'}${v.provider ? ' · ' + esc(v.provider) : ''}${v.batch ? ' · Lot ' + esc(v.batch) : ''}</small></div>
        ${v.nextDue ? `<span class="badge ${v.nextDue < today ? 'danger' : v.nextDue <= addDays(today, 30) ? 'warn' : ''}">Next: ${fmtDate(v.nextDue)}</span>` : ''}
      </div>`).join('')}</div>` : `<div class="empty">Keep the vaccination record here — handy for school, travel and clinic visits.</div>`}</div>`;
}

function apptCard(a) {
  const m = member(a.memberId);
  return `<div class="card tinted" style="--c:${safeColor(m?.color)}">
    <div class="spread"><div class="grow">${chip(m)} ${a.done ? '<span class="badge ok">Done</span>' : `<span class="badge primary">${esc(relDays(a.at))}</span>`}
      <h3 style="margin-top:6px">${esc(a.title)}</h3>
      <small>${fmtDT(a.at)}</small>
      ${a.provider || a.location ? `<div><small>📍 ${esc([a.provider, a.location].filter(Boolean).join(', '))}</small></div>` : ''}
      ${a.notes ? `<p class="prewrap" style="margin:6px 0 0;font-size:.9rem">${esc(a.notes)}</p>` : ''}
      ${a.outcome ? `<p class="prewrap" style="margin:6px 0 0;font-size:.9rem"><strong>Outcome:</strong> ${esc(a.outcome)}</p>` : ''}
    </div></div>
    <div class="row wrap" style="margin-top:10px">
      <button class="btn small" data-action="editAppt" data-id="${a.id}">Edit</button>
      ${!a.done ? `<button class="btn small" data-action="apptICS" data-id="${a.id}">📅 Add to calendar</button>
      <button class="btn small" data-action="apptDone" data-id="${a.id}">Mark done</button>` : ''}
    </div></div>`;
}

function memberVisits(m) {
  const list = S.appointments.filter(a => a.memberId === m.id);
  const now = nowLocalDT();
  const up = sortBy(list.filter(a => !a.done && a.at >= now.slice(0, 10)), 'at');
  const past = sortBy(list.filter(a => a.done || a.at < now.slice(0, 10)), 'at', true);
  return `<div class="spread"><span class="section-title">Upcoming</span><button class="btn small primary" data-action="addAppt" data-member="${m.id}">+ Appointment</button></div>
    <div style="margin-top:10px">${up.length ? up.map(apptCard).join('') : '<div class="empty">No upcoming appointments.</div>'}</div>
    ${past.length ? `<div class="section"><span class="section-title">Past</span><div style="margin-top:10px">${past.map(apptCard).join('')}</div></div>` : ''}`;
}

/* ---------- Meds (all family) ---------- */
function viewMeds() {
  const f = ui.medsFilter;
  const list = S.medications.filter(x => f === 'all' || x.memberId === f);
  const cur = sortBy(list.filter(x => medActiveOn(x, todayISO())), x => (member(x.memberId)?.name || '') + x.name);
  const past = list.filter(x => !medActiveOn(x, todayISO()));
  let html = `<div class="spread"><h1>Medications</h1><button class="btn primary" data-action="addMed">+ Add</button></div><div class="section">${memberPills('medsFilter')}</div>`;
  const low = cur.filter(isLowStock);
  if (low.length) html += `<div class="card alert-warn flat section">🧾 Shopping list: ${low.map(x => `<strong>${esc(x.name)}</strong> (${esc(firstName(member(x.memberId)))})`).join(', ')}</div>`;
  html += `<div class="section">${cur.length ? cur.map(x => medCard(x, true)).join('') : '<div class="empty">No current medications.</div>'}</div>`;
  if (past.length) {
    html += `<div class="section"><button class="btn small ghost" data-action="togglePastMeds">${ui.showPastMeds ? 'Hide' : 'Show'} past medications (${past.length})</button>
      ${ui.showPastMeds ? `<div style="margin-top:10px">${sortBy(past, 'updatedAt', true).map(x => medCard(x, true)).join('')}</div>` : ''}</div>`;
  }
  return html;
}

/* ---------- Visits (all family) ---------- */
function viewVisits() {
  const f = ui.visitsFilter;
  const list = S.appointments.filter(a => f === 'all' || a.memberId === f);
  const today = todayISO();
  const up = sortBy(list.filter(a => !a.done && a.at >= today), 'at');
  const missed = sortBy(list.filter(a => !a.done && a.at < today), 'at', true);
  const past = sortBy(list.filter(a => a.done), 'at', true).slice(0, 20);
  let html = `<div class="spread"><h1>Appointments</h1><button class="btn primary" data-action="addAppt">+ Add</button></div><div class="section">${memberPills('visitsFilter')}</div>`;
  html += `<div class="section"><span class="section-title">Upcoming</span><div style="margin-top:10px">${up.length ? up.map(apptCard).join('') : '<div class="empty">Nothing scheduled.</div>'}</div></div>`;
  if (missed.length) html += `<div class="section"><span class="section-title">Past — not marked done</span><div style="margin-top:10px">${missed.map(apptCard).join('')}</div></div>`;
  if (past.length) html += `<div class="section"><span class="section-title">Completed</span><div style="margin-top:10px">${past.map(apptCard).join('')}</div></div>`;
  return html;
}

/* ---------- Emergency card ---------- */
function viewEmergency(id) {
  const m = member(id);
  if (!m) return `<div class="empty">Not found.</div>`;
  const meds = S.medications.filter(x => x.memberId === m.id && medActiveOn(x, todayISO()));
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
  return `<div class="row no-print" style="margin-bottom:12px">
      <a class="btn small" href="#/member/${m.id}">← Back</a><span class="grow"></span>
      <button class="btn small" data-action="print">🖨 Print / save PDF</button></div>
    <div class="ecard">
      <div class="ehead">${avatar(m, 'lg')}<div><div class="etag">MEDICAL INFORMATION · EMERGENCY</div>
        <div class="big">${esc(m.name)}</div>
        <div>${esc([m.dob && `DOB ${fmtDate(m.dob)} (${ageText(m.dob)})`, m.sex].filter(Boolean).join(' · '))}</div></div></div>
      <dl class="kv">
        ${row('Blood type', `<span class="big">${esc(m.bloodType || 'Unknown')}</span>`)}
        ${row('Allergies', (m.allergies || []).length ? `<span class="allergy">${esc(m.allergies.join(', '))}</span>` : 'No known allergies')}
        ${row('Conditions', esc((m.conditions || []).join(', ')) || 'None recorded')}
        ${row('Medications', meds.length ? meds.map(x => esc(`${x.name}${x.dose ? ' ' + x.dose : ''} — ${scheduleText(x)}`)).join('<br>') : 'None')}
        ${row('Emergency contact', esc(m.emergencyContact))}
        ${row('Doctor', esc(m.doctor))}
        ${row('Insurance', esc(m.insurance))}
        ${row('IC / ID', esc(m.idNumber))}
        ${row('Notes', esc(m.notes))}
      </dl>
      <p class="muted" style="margin:14px 0 0;font-size:.8rem">Updated ${fmtDate(todayISO())}</p>
    </div>
    <p class="muted no-print" style="font-size:.85rem">Tip: take a screenshot and set it as a lock-screen photo, or print and keep it in your wallet / the girls' school bag.</p>`;
}

/* ---------- Settings / backup ---------- */
function viewSettings() {
  const counts = ['members', 'medications', 'vitals', 'records', 'vaccines', 'appointments'].map(s => `${S[s].length} ${s}`).join(' · ');
  const notifState = !('Notification' in window) ? 'unsupported' : Notification.permission;
  return `<h1>Backup & privacy</h1>
  <div class="card section stack">
    <h2>🔒 Your data stays on this device</h2>
    <p style="margin:0" class="muted">There is no account and no server. Health information is stored only in this browser. Because of that, <strong>backups are your responsibility</strong> — export one regularly and keep it somewhere safe (e.g. your own Google Drive / iCloud, encrypted with a password).</p>
    <small>${esc(counts)}</small>
    <small id="persist-status"></small>
  </div>

  <div class="card section stack">
    <h2>💾 Backup</h2>
    <small>Last backup: ${settings.lastBackup ? fmtDT(isoDate(new Date(settings.lastBackup)) + 'T' + hhmm(new Date(settings.lastBackup))) : 'never'}</small>
    <button class="btn primary" data-action="exportBackup" data-encrypt="1">Export encrypted backup (recommended)</button>
    <button class="btn" data-action="exportBackup">Export unencrypted backup</button>
    <label class="btn" style="position:relative">Restore from backup file…
      <input type="file" accept=".json,application/json" data-action="importBackup" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
    <small>Use the same backup file to move everything to a new phone or to your wife's phone.</small>
  </div>

  <div class="card section stack">
    <h2>🔔 Reminders</h2>
    <p style="margin:0" class="muted">Phones only allow web apps to alert while the app is open. For alarms that always work, tap <strong>📅 Phone reminders</strong> on a medication or <strong>📅 Add to calendar</strong> on an appointment — this adds repeating events with alerts to your phone's calendar.</p>
    <button class="btn" data-action="enableNotif" ${notifState === 'granted' || notifState === 'unsupported' ? 'disabled' : ''}>
      ${notifState === 'granted' ? 'In-app notifications enabled ✓' : notifState === 'unsupported' ? 'Notifications not supported here' : notifState === 'denied' ? 'Notifications blocked in browser settings' : 'Enable in-app notifications'}</button>
  </div>

  <div class="card section stack">
    <h2>🔑 App lock</h2>
    <p style="margin:0" class="muted">A PIN keeps casual eyes out when someone borrows your phone. It is a privacy screen, not encryption — protect the phone itself with a screen lock too.</p>
    ${settings.pinHash
      ? `<button class="btn" data-action="setPin">Change PIN</button><button class="btn danger" data-action="removePin">Remove PIN</button>`
      : `<button class="btn" data-action="setPin">Set a PIN</button>`}
  </div>

  <div class="card section stack">
    <h2>⚠ Danger zone</h2>
    <button class="btn danger" data-action="wipe">Erase all data on this device</button>
  </div>
  <p class="muted" style="text-align:center;font-size:.8rem;margin-top:24px">Family Health keeps records; it does not give medical advice. In an emergency call 999 (Malaysia) / 112 from mobile.</p>`;
}

/* =========================================================================
 * 9. Router + render
 * ========================================================================= */
function render() {
  const { page, a, b } = currentRoute();
  let html;
  switch (page) {
    case 'family': html = viewFamily(); break;
    case 'member': html = viewMember(a, b); break;
    case 'meds': html = viewMeds(); break;
    case 'visits': html = viewVisits(); break;
    case 'settings': html = viewSettings(); break;
    case 'emergency': html = viewEmergency(a); break;
    default: html = viewToday();
  }
  $('#view').innerHTML = html;
  const navKey = page === 'member' || page === 'emergency' ? 'family' : page;
  document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === navKey || (navKey === 'today' && n.dataset.nav === 'today' && !['family', 'meds', 'visits', 'settings'].includes(page))));
  $('.fab').hidden = page === 'settings' || page === 'emergency';
  hydrateThumbs();
  if (page === 'settings') showPersistStatus();
}
let lastPage;
window.addEventListener('hashchange', () => {
  const p = location.hash;
  render();
  if (p !== lastPage) { window.scrollTo(0, 0); lastPage = p; }
});

/* =========================================================================
 * 10. Actions (event delegation)
 * ========================================================================= */
const find = (store, id) => S[store].find(x => x.id === id);
const actions = {
  goto: d => { location.hash = d.href; },
  filter: d => { ui[d.key] = d.val; render(); },
  vitalType: d => { ui.vitalType = d.type; render(); },
  togglePastMeds: () => { ui.showPastMeds = !ui.showPastMeds; render(); },
  print: () => window.print(),

  quickAdd: () => {
    if (!S.members.length) { location.hash = '#/today'; toast('Set up your family first'); return; }
    const mid = currentMemberId();
    const item = (act, em, label) => `<button class="btn" data-action="${act}" ${mid ? `data-member="${mid}"` : ''}><span class="em">${em}</span>${label}</button>`;
    openSheet(mid ? `Add for ${firstName(member(mid))}` : 'Add', `<div class="menu-list">
      ${item('addVital', '🌡️', 'Temperature / weight / BP reading')}
      ${item('addMed', '💊', 'Medication')}
      ${item('addRecord', '📝', 'Sick day, clinic visit or lab result')}
      ${item('addAppt', '📅', 'Appointment')}
      ${item('addVaccine', '💉', 'Vaccination')}
      ${mid ? '' : item('addMember', '👤', 'Family member')}
    </div>`);
  },

  quickStart: async () => {
    const seed = [['Me', 'Self', 'Male'], ['Wife', 'Spouse', 'Female'], ['Kakak (elder daughter)', 'Daughter', 'Female'], ['Adik (younger daughter)', 'Daughter', 'Female']];
    for (let i = 0; i < seed.length; i++) {
      const [name, relation, sex] = seed[i];
      await save('members', { name, relation, sex, color: MEMBER_COLORS[i], allergies: [], conditions: [] });
    }
    location.hash = '#/family';
    toast('Family created — tap each person to add their name, birthday and details');
  },

  addMember: () => memberForm(),
  editMember: d => memberForm(find('members', d.id)),
  addMed: d => medForm(null, d.member),
  editMed: d => medForm(find('medications', d.id)),
  addVital: d => vitalForm(null, d.member, d.type),
  editVital: d => vitalForm(find('vitals', d.id)),
  addAppt: d => apptForm(null, d.member),
  editAppt: d => apptForm(find('appointments', d.id)),
  addVaccine: d => vaccineForm(null, d.member),
  editVaccine: d => vaccineForm(find('vaccines', d.id)),
  addRecord: d => recordForm(null, d.member),
  editRecord: d => recordForm(find('records', d.id)),

  dose: d => setDose(d.id, d.status),
  prn: d => logPrn(d.id),
  undoPrn: d => undoPrn(d.id),
  apptDone: async d => { const a = find('appointments', d.id); a.done = true; await save('appointments', a); toast('Marked done — add the outcome via Edit'); render(); },
  apptICS: d => { const a = find('appointments', d.id); download(`${fileSafe(a.title)}.ics`, apptICS(a), 'text/calendar'); },
  medICS: d => {
    const m = find('medications', d.id);
    download(`${fileSafe(m.name)}-reminders.ics`, medICS(m), 'text/calendar');
    toast('Open the downloaded file to add the reminders to your calendar');
  },

  openFile: async d => {
    const url = await fileURL(d.id);
    if (url) window.open(url, '_blank', 'noopener');
  },
  delAttachment: async (d, el, e) => {
    e.stopPropagation();
    const r = find('records', d.record);
    if (!r || !confirm('Remove this attachment?')) return;
    r.attachments = (r.attachments || []).filter(a => a.id !== d.id);
    await idb.del('files', d.id);
    await save('records', r);
    render();
  },

  exportBackup: d => exportBackup(!!d.encrypt),
  enableNotif: async () => {
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Notifications enabled' : 'Notifications not allowed');
    render();
  },
  setPin: () => openForm({
    title: settings.pinHash ? 'Change PIN' : 'Set a PIN',
    fields: [
      { name: 'pin', label: 'New PIN (4–8 digits)', type: 'password', required: true },
      { name: 'pin2', label: 'Repeat PIN', type: 'password', required: true },
    ],
    onSave: async v => {
      if (!/^\d{4,8}$/.test(v.pin)) return 'PIN must be 4–8 digits.';
      if (v.pin !== v.pin2) return 'PINs do not match.';
      const salt = uid();
      await saveSettings({ pinSalt: salt, pinHash: await sha256(salt + v.pin) });
      toast('PIN set');
    },
  }),
  removePin: async () => {
    if (!confirm('Remove the app PIN?')) return;
    await saveSettings({ pinHash: null, pinSalt: null });
    toast('PIN removed'); render();
  },
  wipe: async () => {
    if (!confirm('Erase ALL family health data on this device?')) return;
    if (prompt('Type ERASE to confirm. Make sure you have a backup.') !== 'ERASE') return;
    for (const s of STORES) await idb.clear(s);
    await loadAll();
    location.hash = '#/today';
    toast('All data erased'); render();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.closest('dialog') && el.dataset.action !== 'quickAdd') modal().close();
  fn(el.dataset, el, e);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-action]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-action=importBackup]')) {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  }
});

/* =========================================================================
 * 11. Backup (export / import, optional AES-GCM encryption)
 * ========================================================================= */
const enc = new TextEncoder(), dec = new TextDecoder();
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const blobToDataURL = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

async function buildBackup() {
  const data = {};
  for (const s of CACHED) data[s] = await idb.all(s);
  data.meta = data.meta.map(m => m.id === 'settings' ? { ...m, pinHash: null, pinSalt: null } : m);
  const files = await idb.all('files');
  data.files = [];
  for (const f of files) data.files.push({ ...f, blob: await blobToDataURL(f.blob) });
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

function exportBackup(encrypt) {
  if (!encrypt) return doExport(null);
  if (!crypto.subtle) { alert('Encryption needs a secure (https) connection.'); return; }
  openForm({
    title: 'Encrypted backup',
    submitLabel: 'Export',
    intro: `<p class="muted" style="margin:0">Choose a strong password. <strong>Without it the backup cannot be opened</strong> — there is no recovery. Write it down somewhere safe.</p>`,
    fields: [
      { name: 'pw', label: 'Password (min. 8 characters)', type: 'password', required: true },
      { name: 'pw2', label: 'Repeat password', type: 'password', required: true },
    ],
    onSave: async v => {
      if (v.pw.length < 8) return 'Use at least 8 characters.';
      if (v.pw !== v.pw2) return 'Passwords do not match.';
      await doExport(v.pw);
    },
  });
}
async function doExport(password) {
  const backup = await buildBackup();
  let out = JSON.stringify(backup);
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(out)));
    out = JSON.stringify({ format: BACKUP_FORMAT + '-encrypted', version: BACKUP_VERSION, kdf: 'PBKDF2-SHA256-310000', cipher: 'AES-256-GCM', salt: b64(salt), iv: b64(iv), data: b64(ct) });
  }
  download(`family-health-backup-${todayISO()}${password ? '-encrypted' : ''}.json`, out, 'application/json');
  await saveSettings({ lastBackup: Date.now() });
  toast('Backup exported');
  render();
}

async function importBackup(file) {
  let obj;
  try { obj = JSON.parse(await file.text()); } catch { alert('This is not a valid backup file.'); return; }
  if (obj.format === BACKUP_FORMAT + '-encrypted') {
    const pw = prompt('This backup is encrypted. Enter its password:');
    if (!pw) return;
    try {
      const key = await deriveKey(pw, unb64(obj.salt));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, key, unb64(obj.data));
      obj = JSON.parse(dec.decode(pt));
    } catch { alert('Wrong password or damaged file.'); return; }
  }
  if (obj.format !== BACKUP_FORMAT || !obj.data) { alert('This is not a Family Health backup.'); return; }
  const d = obj.data;
  if (!confirm(`Restore backup from ${fmtDT(obj.exportedAt)}?\n\n${(d.members || []).length} members, ${(d.medications || []).length} medications, ${(d.records || []).length} records.\n\nThis REPLACES everything currently on this device.`)) return;
  const keepPin = { pinHash: settings.pinHash, pinSalt: settings.pinSalt };
  for (const s of STORES) await idb.clear(s);
  for (const s of CACHED) for (const row of d[s] || []) await idb.put(s, row);
  for (const f of d.files || []) {
    const blob = await (await fetch(f.blob)).blob();
    await idb.put('files', { ...f, blob });
  }
  await loadAll();
  await saveSettings({ ...keepPin, lastBackup: Date.now() });
  fileURLs.clear();
  location.hash = '#/today';
  toast('Backup restored');
  render();
}

/* =========================================================================
 * 12. App lock
 * ========================================================================= */
function showLock() {
  return new Promise(resolve => {
    const el = $('#lock');
    el.innerHTML = `<form><img src="icons/icon.svg" width="64" height="64" alt="" style="margin:0 auto">
      <h1>Family Health</h1><p class="muted" style="margin:0">Enter your PIN</p>
      <input type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN" required>
      <button class="btn primary" type="submit">Unlock</button>
      <p class="muted" style="font-size:.8rem;margin:0">Forgot the PIN? Clear this site's data in your browser settings and restore from a backup.</p></form>`;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    const input = el.querySelector('input');
    input.focus();
    el.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      if (await sha256(settings.pinSalt + input.value) === settings.pinHash) {
        el.hidden = true; el.innerHTML = '';
        document.body.style.overflow = '';
        resolve();
      } else {
        input.value = '';
        input.placeholder = 'Wrong PIN';
        input.animate?.([{ transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'none' }], { duration: 250 });
      }
    });
  });
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (settings.pinHash && hiddenAt && Date.now() - hiddenAt > 2 * 60e3 && $('#lock').hidden) {
    modal().open && modal().close();
    showLock();
  }
});

/* =========================================================================
 * 13. In-app reminders (while the app is open)
 * ========================================================================= */
const notified = new Set();
async function notify(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    else new Notification(title, { body, tag });
  } catch (e) { console.warn(e); }
}
function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date(), today = isoDate(now), t = hhmm(now);
  for (const d of scheduledDoses(today)) {
    if (d.status || d.time > t || notified.has(d.id)) continue;
    // Only alert for doses that became due in the last 15 minutes
    const [h, m] = d.time.split(':').map(Number);
    const dueAt = new Date(now); dueAt.setHours(h, m, 0, 0);
    notified.add(d.id);
    if (now - dueAt <= 15 * 60e3) notify(`💊 ${firstName(member(d.med.memberId))}: ${d.med.name}`, `${d.med.dose || ''} ${d.med.instructions || ''}`.trim() || 'Time for this dose', d.id);
  }
}

/* =========================================================================
 * 14. Boot
 * ========================================================================= */
async function showPersistStatus() {
  const el = $('#persist-status');
  if (!el || !navigator.storage?.persisted) return;
  const p = await navigator.storage.persisted();
  const est = await navigator.storage.estimate?.();
  el.textContent = `${p ? 'Storage is protected from automatic clean-up ✓' : 'Storage may be cleared by the browser if the device runs low on space — install the app to home screen and keep backups.'}${est?.usage ? ` · Using ${(est.usage / 1048576).toFixed(1)} MB` : ''}`;
}

async function init() {
  try {
    await openDB();
    await loadAll();
  } catch (e) {
    $('#view').innerHTML = `<div class="card alert-danger">Could not open the local database. Private / incognito mode may block storage.<br><small>${esc(e.message || e)}</small></div>`;
    return;
  }
  if (settings.pinHash) await showLock();
  lastPage = location.hash;
  render();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  checkReminders();
  setInterval(() => {
    checkReminders();
    // Refresh "Today" at midnight / to update overdue state, unless a dialog is open
    if (currentRoute().page === 'today' && !modal().open && document.visibilityState === 'visible') render();
  }, 60e3);
}
init();

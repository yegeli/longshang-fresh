// Test-only CloudBase database boundary. CloudBase uses snapshot isolation:
// reads do not lock documents or make unrelated writes conflict. Each transaction
// gets a snapshot at its first operation and checks versions only for documents
// it writes; no global lock serializes requests.
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const keyOf = (collection, id) => JSON.stringify([collection, id]);
const conflict = () => Object.assign(new Error('Test database transaction conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });

class Document {
  constructor(owner, name, id) { Object.assign(this, { owner, name, id }); }
  async get() { return { data: this.owner.read(this.name, this.id) }; }
  async set({ data }) { this.owner.write(this.name, this.id, data); return { _id: this.id }; }
}
class Collection {
  constructor(owner, name, filter = {}, sorting = null, maximum = 100) { Object.assign(this, { owner, name, filter, sorting, maximum }); }
  doc(id) { return new Document(this.owner, this.name, id); }
  where(filter) { return new Collection(this.owner, this.name, filter, this.sorting, this.maximum); }
  orderBy(field, direction) { return new Collection(this.owner, this.name, this.filter, { field, direction }, this.maximum); }
  limit(maximum) { return new Collection(this.owner, this.name, this.filter, this.sorting, maximum); }
  async get() {
    let rows = this.owner.list(this.name).filter(row => Object.entries(this.filter).every(([field, condition]) =>
      condition && typeof condition === 'object' && condition.__operator === 'lt' ? row[field] < condition.value : row[field] === condition));
    if (this.sorting) {
      const { field, direction } = this.sorting, factor = direction === 'desc' ? -1 : 1;
      rows.sort((a, b) => a[field] < b[field] ? -factor : a[field] > b[field] ? factor : 0);
    }
    return { data: rows.slice(0, this.maximum).map(copy) };
  }
}
class Transaction {
  constructor(db) { this.db = db; this.snapshot = null; this.writes = new Map(); this.closed = false; }
  collection(name) { return new Collection(this, name); }
  assertOpen() { if (this.closed) throw new Error('Transaction already closed'); }
  remember(name, id) {
    if (!this.snapshot) this.snapshot = new Map([...this.db.records].map(([key, row]) => [key, copy(row)]));
    const key = keyOf(name, id);
    return key;
  }
  read(name, id) {
    this.assertOpen(); const key = this.remember(name, id);
    if (this.writes.has(key)) return copy({ ...this.writes.get(key), _id: id });
    const current = this.snapshot.get(key);
    return current ? copy({ ...current.data, _id: id }) : null;
  }
  write(name, id, data) {
    this.assertOpen(); const key = this.remember(name, id);
    if (this.db.failWrite?.({ collection: name, id, data: copy(data) })) throw new Error('Injected test write failure');
    this.writes.set(key, copy(data));
  }
  list(name) {
    this.assertOpen();
    this.remember(name, '');
    const ids = new Set([...this.snapshot.keys(), ...this.writes.keys()].map(key => JSON.parse(key)).filter(([collection]) => collection === name).map(([, id]) => id));
    return [...ids].map(id => this.read(name, id)).filter(Boolean);
  }
  async commit() {
    this.assertOpen();
    for (const key of this.writes.keys()) if ((this.db.records.get(key)?.version || 0) !== (this.snapshot?.get(key)?.version || 0)) { this.closed = true; throw conflict(); }
    if (this.db.failCommit) { const injected = this.db.failCommit; this.db.failCommit = null; this.closed = true; throw typeof injected === 'function' ? injected() : injected; }
    // JavaScript executes this commit section synchronously, exactly one
    // optimistic commit winning per shared version; no writes happen on failure.
    for (const [key, data] of this.writes) this.db.records.set(key, { version: (this.db.records.get(key)?.version || 0) + 1, data: copy(data) });
    this.closed = true; this.db.commits++; return {};
  }
  async rollback() { this.writes.clear(); this.closed = true; this.db.rollbacks++; return {}; }
}

export class MemoryCloudbaseDB {
  constructor() {
    this.records = new Map(); this.command = { lt: value => ({ __operator: 'lt', value }) };
    this.commits = 0; this.rollbacks = 0; this.failCommit = null; this.failWrite = null;
  }
  collection(name) { return new Collection(this, name); }
  async startTransaction() { return new Transaction(this); }
  read(name, id) { const current = this.records.get(keyOf(name, id)); return current ? copy({ ...current.data, _id: id }) : null; }
  write(name, id, data) { const key = keyOf(name, id); this.records.set(key, { version: (this.records.get(key)?.version || 0) + 1, data: copy(data) }); }
  list(name) { return [...this.records.entries()].filter(([key]) => JSON.parse(key)[0] === name).map(([key, row]) => copy({ ...row.data, _id: JSON.parse(key)[1] })); }
  dump(name) { return name ? this.list(name) : [...this.records.entries()].map(([key, row]) => ({ collection: JSON.parse(key)[0], id: JSON.parse(key)[1], version: row.version, data: copy(row.data) })); }
}

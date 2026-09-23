// A tiny in-memory Firestore: only what the sender touches (documents, the
// collection queries it uses, collection-group queries, create-only writes).
// Shared by the tests and by anything that wants to run the sender against
// real schedule data without a database.
//
// hooks.onSet(path, data, opts)  runs before every set, and may throw
// hooks.onGroupGet()             runs before every collection-group query

export function makeDb() {
  const store = new Map();
  const hooks = { onSet: null, onGroupGet: null };

  const docRef = path => ({
    path,
    id: path.split('/').pop(),
    get parent() { return colRef(path.split('/').slice(0, -1).join('/')); },
    async get() {
      const has = store.has(path);
      return { exists: has, id: path.split('/').pop(), ref: docRef(path), data: () => (has ? structuredClone(store.get(path)) : undefined) };
    },
    async set(data, opts) {
      if (hooks.onSet) hooks.onSet(path, data, opts);
      store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...structuredClone(data) } : structuredClone(data));
    },
    async create(data) {
      if (store.has(path)) throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists: ' + path), { code: 6 });
      store.set(path, structuredClone(data));
    },
    async delete() { store.delete(path); },
    collection: name => colRef(path + '/' + name)
  });

  const snapOf = entries => ({
    docs: entries.map(([p, data]) => ({ id: p.split('/').pop(), ref: docRef(p), exists: true, data: () => structuredClone(data) }))
  });
  const passes = (data, filters) => filters.every(([f, op, v]) => (op === '==' ? data[f] === v : op === '>=' ? data[f] >= v : op === '<=' ? data[f] <= v : false));

  const colRef = path => {
    const filters = [];
    const c = {
      path,
      get parent() { const p = path.split('/').slice(0, -1).join('/'); return p ? docRef(p) : null; },
      doc: id => docRef(path + '/' + id),
      where(f, op, v) { filters.push([f, op, v]); return c; },
      async get() {
        const prefix = path + '/';
        return snapOf([...store.entries()].filter(([p, d]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && passes(d, filters)));
      }
    };
    return c;
  };

  return {
    store, hooks,
    collection: name => colRef(name),
    collectionGroup(name) {
      const filters = [];
      const g = {
        where(f, op, v) { filters.push([f, op, v]); return g; },
        async get() {
          if (hooks.onGroupGet) hooks.onGroupGet();
          return snapOf([...store.entries()].filter(([p, d]) => {
            const seg = p.split('/');
            return seg.length % 2 === 0 && seg[seg.length - 2] === name && passes(d, filters);
          }));
        }
      };
      return g;
    }
  };
}

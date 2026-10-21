// Local stress suite. Oracles/checks stay outside solver workspaces.
// Fixed seed and fully specified semantics prevent post-result task selection.
function rng(seed) { return n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }; }

// Exhaustive feasible-flow enumeration is independent of residual-network solvers.
export function flowOracle({ n, edges, source, sink, limit }) {
  const balance = Array(n).fill(0);
  let bestFlow = -1, bestCost = Infinity;
  function visit(i, cost) {
    if (i === edges.length) {
      const flow = balance[source];
      if (flow < 0 || flow > limit || balance[sink] !== -flow) return;
      if (balance.some((b, v) => v !== source && v !== sink && b !== 0)) return;
      if (flow > bestFlow || flow === bestFlow && cost < bestCost) { bestFlow = flow; bestCost = cost; }
      return;
    }
    const [u, v, capacity, price] = edges[i];
    for (let amount = 0; amount <= capacity; amount++) {
      balance[u] += amount; balance[v] -= amount;
      visit(i + 1, cost + amount * price);
      balance[u] -= amount; balance[v] += amount;
    }
  }
  visit(0, 0);
  return { flow: bestFlow, cost: bestCost };
}

function flowChecks() {
  const inputs = [
    { n: 2, edges: [], source: 0, sink: 1, limit: 5 },
    { n: 4, edges: [[0, 1, 2, 3], [2, 3, 2, -5], [3, 2, 2, 1]], source: 0, sink: 1, limit: 0 },
    { n: 4, edges: [[0, 1, 1, 0], [0, 2, 1, 0], [1, 2, 1, -2], [1, 3, 1, 0], [2, 3, 1, 0]], source: 0, sink: 3, limit: 2 },
    { n: 3, edges: [[0, 1, 2, 4], [0, 1, 1, -2], [1, 0, 1, -3], [1, 2, 3, 1], [1, 1, 2, -4]], source: 0, sink: 2, limit: 3 },
  ];
  const random = rng(5303101);
  for (let i = 0; i < 64; i++) {
    const n = 2 + random(4), edges = [];
    for (let e = 0; e < 4 + random(5); e++) edges.push([random(n), random(n), random(3), random(13) - 6]);
    inputs.push({ n, edges, source: 0, sink: n - 1, limit: random(5) });
  }
  const checks = inputs.map((input, i) => [`exhaustive network ${i}`, [input], flowOracle(input)]);
  // Analytic larger instances prevent a brute-force-only submission from passing.
  for (let k = 1; k <= 8; k++) {
    const edges = [], limit = 20 + k;
    for (let i = 0; i < 18; i++) edges.push([i, i + 1, 50, i % 2 ? -1 : 3]);
    edges.push([19, 20, 40, -7], [20, 19, 40, 2], [21, 21, 30, -3]);
    checks.push([`large chain with disconnected cycles ${k}`, [{ n: 22, edges, source: 0, sink: 18, limit }], { flow: limit, cost: limit * 18 - 290 }]);
  }
  return checks;
}

// Canonical edit extraction is defined by the prompt, including its LCS tie rule.
export function canonicalEdits(base, side) {
  const table = Array.from({ length: base.length + 1 }, () => Array(side.length + 1).fill(0));
  for (let i = base.length - 1; i >= 0; i--) for (let j = side.length - 1; j >= 0; j--)
    table[i][j] = base[i] === side[j] ? 1 + table[i + 1][j + 1] : Math.max(table[i + 1][j], table[i][j + 1]);
  const matches = []; let i = 0, j = 0;
  while (i < base.length && j < side.length) {
    if (base[i] === side[j]) { matches.push([i++, j++]); }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  matches.push([base.length, side.length]);
  const edits = []; let a = 0, b = 0;
  for (const [x, y] of matches) {
    if (x !== a || y !== b) edits.push({ start: a, end: x, lines: side.slice(b, y) });
    a = x + 1; b = y + 1;
  }
  return edits;
}

export function mergeOracle(base, left, right) {
  const edits = [...canonicalEdits(base, left).map(e => ({ ...e, side: 0 })), ...canonicalEdits(base, right).map(e => ({ ...e, side: 1 }))];
  const overlap = (a, b) => {
    if (a.start === a.end && b.start === b.end) return a.start === b.start;
    if (a.start === a.end) return b.start < a.start && a.start < b.end;
    if (b.start === b.end) return a.start < b.start && b.start < a.end;
    return Math.max(a.start, b.start) < Math.min(a.end, b.end);
  };
  const components = [], seen = new Set();
  for (let i = 0; i < edits.length; i++) {
    if (seen.has(i)) continue;
    const component = [], queue = [i]; seen.add(i);
    while (queue.length) {
      const index = queue.pop(); component.push(edits[index]);
      for (let k = 0; k < edits.length; k++) if (!seen.has(k) && edits[index].side !== edits[k].side && overlap(edits[index], edits[k])) { seen.add(k); queue.push(k); }
    }
    components.push(component);
  }
  const span = c => [Math.min(...c.map(e => e.start)), Math.max(...c.map(e => e.end))];
  components.sort((a, b) => span(a)[0] - span(b)[0] || span(a)[1] - span(b)[1]);
  const blocks = [];
  const ok = lines => { if (!lines.length) return; if (blocks.at(-1)?.type === 'ok') blocks.at(-1).lines.push(...lines); else blocks.push({ type: 'ok', lines: [...lines] }); };
  let cursor = 0;
  for (const c of components) {
    const [start, end] = span(c); ok(base.slice(cursor, start));
    const render = side => {
      const result = []; let position = start;
      for (const e of c.filter(e => e.side === side).sort((a, b) => a.start - b.start || a.end - b.end)) { result.push(...base.slice(position, e.start), ...e.lines); position = e.end; }
      result.push(...base.slice(position, end)); return result;
    };
    const l = render(0), r = render(1);
    if (!c.some(e => e.side === 0)) ok(r);
    else if (!c.some(e => e.side === 1) || JSON.stringify(l) === JSON.stringify(r)) ok(l);
    else blocks.push({ type: 'conflict', base: base.slice(start, end), left: l, right: r });
    cursor = end;
  }
  ok(base.slice(cursor)); return blocks;
}

function mergeChecks() {
  const triples = [
    [[], [], []], [[], ['x'], ['y']], [[], ['x'], ['x']],
    [['a', 'b'], ['A', 'b'], ['a', 'B']],
    [['a', 'b'], ['x', 'a', 'b'], ['A', 'b']],
    [['a', 'b', 'c'], ['a', 'c'], ['a', 'B', 'c']],
    [['x', 'x', 'y'], ['x', 'y'], ['x', 'z', 'y']],
    [['a', 'b', 'c', 'd'], ['L', 'c', 'd'], ['a', 'R', 'd']],
    [['a', 'b', 'c'], ['x', 'a', 'b', 'c', 'y'], ['A', 'b', 'C']],
  ];
  const random = rng(5303201), alphabet = ['a', 'b', 'c', '', 'α'];
  for (let i = 0; i < 80; i++) {
    const base = Array.from({ length: 2 + random(10) }, () => alphabet[random(alphabet.length)]);
    const mutate = () => { const side = [...base]; for (let j = 0; j < 1 + random(5); j++) side.splice(random(side.length + 1), random(3), ...Array.from({ length: random(3) }, () => alphabet[random(alphabet.length)])); return side; };
    triples.push([base, mutate(), mutate()]);
  }
  return triples.map((args, i) => [`canonical merge ${i}`, args, mergeOracle(...args)]);
}

// Journal replay oracle: snapshots are rebuilt from committed events, rather than
// maintained by the transaction algorithm a submission would normally implement.
export function transactionOracle(commands) {
  const journal = [], active = new Map(); let version = 0;
  const snapshot = at => { const result = new Map(); for (const event of journal) if (event.version <= at) for (const [k, v] of event.writes) { if (v === null) result.delete(k); else result.set(k, v); } return result; };
  return commands.map(c => {
    if (c.op === 'begin') { active.set(c.tx, { version, writes: new Map(), reads: new Set(), prefixes: [], savepoints: [] }); return null; }
    const t = active.get(c.tx);
    if (c.op === 'get') { t.reads.add(c.key); return t.writes.has(c.key) ? t.writes.get(c.key) : snapshot(t.version).get(c.key) ?? null; }
    if (c.op === 'scan') {
      t.prefixes.push(c.prefix); const view = snapshot(t.version);
      for (const [k, v] of t.writes) { if (v === null) view.delete(k); else view.set(k, v); }
      return [...view].filter(([k]) => k.startsWith(c.prefix)).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    }
    if (c.op === 'put' || c.op === 'delete') { t.writes.set(c.key, c.op === 'delete' ? null : c.value); return null; }
    if (c.op === 'savepoint') {
      const i = t.savepoints.findIndex(s => s.name === c.name); if (i >= 0) t.savepoints.splice(i);
      t.savepoints.push({ name: c.name, writes: new Map(t.writes) }); return null;
    }
    if (c.op === 'rollbackTo' || c.op === 'release') {
      const i = t.savepoints.findIndex(s => s.name === c.name);
      if (c.op === 'rollbackTo') { t.writes = new Map(t.savepoints[i].writes); t.savepoints.splice(i + 1); }
      else t.savepoints.splice(i);
      return null;
    }
    active.delete(c.tx);
    if (c.op === 'abort') return null;
    const conflicts = new Set();
    for (const event of journal) if (event.version > t.version) for (const [k] of event.writes)
      if (t.reads.has(k) || t.writes.has(k) || t.prefixes.some(prefix => k.startsWith(prefix))) conflicts.add(k);
    if (conflicts.size) return { committed: false, conflicts: [...conflicts].sort() };
    if (t.writes.size) journal.push({ version: ++version, writes: [...t.writes] });
    return { committed: true, version };
  });
}

function transactionChecks() {
  const b = tx => ({ op: 'begin', tx }), p = (tx, key, value) => ({ op: 'put', tx, key, value }), g = (tx, key) => ({ op: 'get', tx, key }), c = tx => ({ op: 'commit', tx });
  const cases = [
    [], [b('a'), c('a')],
    [b('a'), b('b'), g('a', 'x'), p('b', 'x', '1'), c('b'), g('a', 'x'), c('a')],
    [b('a'), b('b'), { op: 'scan', tx: 'a', prefix: 'p/' }, p('b', 'p/new', 'x'), c('b'), c('a')],
    [b('a'), b('b'), { op: 'savepoint', tx: 'a', name: 's' }, g('a', 'x'), { op: 'rollbackTo', tx: 'a', name: 's' }, p('b', 'x', 'v'), c('b'), c('a')],
    [b('a'), p('a', '__proto__', 'v'), p('a', 'constructor', 'w'), c('a'), b('b'), { op: 'scan', tx: 'b', prefix: '' }, c('b')],
    [b('old'), b('w'), p('w', 'x', 'v'), c('w'), b('del'), { op: 'delete', tx: 'del', key: 'x' }, c('del'), g('old', 'x'), c('old')],
  ];
  const random = rng(5303301), keys = ['a', 'b', 'p/a', 'p/b', '__proto__', 'constructor', ''];
  for (let i = 0; i < 64; i++) {
    const commands = [];
    for (let round = 0; round < 4; round++) {
      commands.push(b('a'), b('b'), b('c'));
      for (const tx of ['a', 'b', 'c']) {
        commands.push({ op: 'savepoint', tx, name: 'outer' });
        for (let k = 0; k < 6; k++) {
          const key = keys[random(keys.length)], choice = random(4);
          commands.push(choice === 0 ? g(tx, key) : choice === 1 ? p(tx, key, `v${random(10)}`) : choice === 2 ? { op: 'delete', tx, key } : { op: 'scan', tx, prefix: ['', 'p/', 'a', 'no'][random(4)] });
        }
        commands.push({ op: 'savepoint', tx, name: 'inner' }, p(tx, keys[random(keys.length)], 'inner'));
        if (random(2)) commands.push({ op: 'rollbackTo', tx, name: 'outer' });
        else commands.push({ op: 'release', tx, name: 'inner' });
        if (random(2)) commands.push(p(tx, keys[random(keys.length)], 'after'));
      }
      const order = random(2) ? ['a', 'b', 'c'] : ['c', 'b', 'a'];
      for (const tx of order) commands.push(random(5) === 0 ? { op: 'abort', tx } : c(tx));
    }
    commands.push(b('verify'), { op: 'scan', tx: 'verify', prefix: '' }, c('verify'));
    cases.push(commands);
  }
  return cases.map((commands, i) => [`transaction schedule ${i}`, [commands], transactionOracle(commands)]);
}

export const hardTasks = [
  { id: 'mincost-flow', name: 'minCostFlow', file: 'solution.mjs', checks: flowChecks(),
    prompt: `Implement export function minCostFlow({n, edges, source, sink, limit}) in solution.mjs without dependencies.
Each edge is [from,to,capacity,cost]. Choose integer edge flows between 0 and capacity, conserve flow
at every vertex except distinct source/sink, and return {flow,cost}: maximize net source outflow
within [0,limit], then minimize total sum(edgeFlow*edgeCost) among all flows of that maximum value.
Circulations are allowed, including negative-cost cycles disconnected from source/sink, even when
limit=0. Include their cost in the optimum. Parallel, antiparallel and self-loop edges are allowed.
Finite capacities bound every negative cycle. Inputs are valid integers: 2<=n<=24, at most 80 edges,
capacity/limit in [0,50], cost in [-20,20], vertex indices in [0,n). Empty edges are allowed.
Do not mutate inputs. Handle these limits without enumerating all combinations of edge flows.
Example: n=4, edges=[[0,1,2,3],[2,3,2,-5],[3,2,2,1]], source=0,sink=1,limit=1 => {flow:1,cost:-5}.` },
  { id: 'three-way-merge', name: 'merge3', file: 'solution.mjs', checks: mergeChecks(),
    prompt: `Implement export function merge3(base,left,right) in solution.mjs without dependencies.
Inputs are arrays of lines (arbitrary strings; no newline parsing), at most 150 lines each.
Return ordered blocks {type:'ok',lines:[...]} or {type:'conflict',base:[...],left:[...],right:[...]}.
Use this EXACT canonical diff and conflict policy (it differs from some diff3 tools):
1. For each side compute suffix LCS lengths L(i,j). Traverse from (0,0): equal lines MUST match
and advance both; otherwise advance the base index if L(i+1,j)>=L(i,j+1), else advance the side.
Each gap between matched pairs, including leading/trailing gaps, is one edit [start,end) in base
coordinates plus replacement lines. Omit gaps with no deletion and no insertion.
2. Build a graph of edits. Edges connect edits from OPPOSITE sides only when their base intervals
overlap with positive length; an insertion overlaps a nonempty interval only STRICTLY inside it;
two insertions overlap iff at the same position. Touching nonempty intervals do not overlap.
Use transitive connected components, not just pairwise conflicts. A component spans min(start)
to max(end). Sort components by start then end (insertions before replacements at the same start).
3. Emit unchanged base between components. For each component, independently apply its edits for
each side to that component's base span, preserving base gaps. If edits occur on just one side,
emit that side as ok. If both resulting arrays are equal, emit them once as ok. Otherwise emit
one conflict block with the base span and both resulting arrays. Emit trailing unchanged base.
4. Coalesce adjacent ok blocks; drop empty ok blocks, but never drop conflict blocks.
Do not mutate any input. All-empty inputs return []. Duplicate and empty lines are significant.
Example: base=['a','b'], left=['A','b'], right=['a','B'] => [{type:'ok',lines:['A','B']}].` },
  { id: 'mvcc', name: 'simulateTransactions', file: 'solution.mjs', checks: transactionChecks(),
    prompt: `Implement export function simulateTransactions(commands) in solution.mjs without dependencies.
Simulate an initially empty string key/value database and return one result for EVERY command.
Commands are valid objects. tx identifies a currently active transaction (except begin); ids may be
reused after completion. Keys/values are arbitrary strings, including empty and '__proto__'.
begin {op:'begin',tx}: capture current commit version and immutable database snapshot; return null.
get {op:'get',tx,key}: record a key read, return own pending value/deletion first, else snapshot value
or null when absent. Every get records a read, even own writes and missing keys.
scan {op:'scan',tx,prefix}: record a prefix read; return [key,value] pairs from snapshot overlaid with
own writes/deletes, whose keys start with prefix, sorted by JS string/code-unit order (not locale).
put {op:'put',tx,key,value} and delete {op:'delete',tx,key}: set pending write (delete even if absent);
return null. get/scan must remain repeatable except own writes.
savepoint {op:'savepoint',tx,name}: save pending writes. If name exists, remove it and all later
savepoints first. rollbackTo {op:'rollbackTo',tx,name}: restore those writes and remove later
savepoints, retaining the named one. release {op:'release',tx,name}: remove it and later savepoints
without changing writes. These return null. Read-key/prefix sets NEVER roll back. Names used by
rollbackTo/release exist. Savepoint restoration must not alias mutable pending writes.
commit {op:'commit',tx}: collect every key written by ANY successful commit after this transaction
began that either was read by get, is in its final pending writes, or matches ANY scanned prefix.
If any, discard transaction and return {committed:false,conflicts:[sorted distinct keys]}.
Otherwise atomically apply writes, increment global version by one iff pending writes are nonempty,
discard transaction, return {committed:true,version:currentGlobalVersion}. Version starts at 0.
Writing the same value or deleting an absent key still counts as a write and causes conflicts.
Read-only transactions still validate. Changed-then-restored keys still conflict (track history).
abort {op:'abort',tx}: discard transaction, return null. No command may mutate the input.
At most 500 commands and 20 concurrent transactions. Output includes nulls for all control writes.` },
];

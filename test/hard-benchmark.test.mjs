import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grade } from '../benchmark/tasks.mjs';
import { hardTasks, mergeOracle, transactionOracle } from '../benchmark/hard-tasks.mjs';

// Independent polynomial reference: maximize flow, then cancel all negative
// residual cycles. The fixture oracle instead enumerates feasible edge flows.
function residualFlow({ n, edges, source, sink, limit }) {
  const residual = [];
  for (const [u, v, cap, cost] of edges) residual.push({ u, v, cap, cost }, { u: v, v: u, cap: 0, cost: -cost });
  const augment = (indexes, amount) => { for (const i of indexes) { residual[i].cap -= amount; residual[i ^ 1].cap += amount; } };
  let flow = 0;
  while (flow < limit) {
    const parents = Array(n).fill(-1), visited = new Set([source]), queue = [source];
    for (const u of queue) for (let i = 0; i < residual.length; i++) {
      const e = residual[i];
      if (e.u === u && e.cap > 0 && !visited.has(e.v)) { visited.add(e.v); parents[e.v] = i; queue.push(e.v); }
    }
    if (!visited.has(sink)) break;
    const path = []; for (let v = sink; v !== source;) { const i = parents[v]; path.push(i); v = residual[i].u; }
    const amount = Math.min(limit - flow, ...path.map(i => residual[i].cap)); augment(path, amount); flow += amount;
  }
  while (true) {
    const distance = Array(n).fill(0), parent = Array(n).fill(-1); let last = -1;
    for (let pass = 0; pass < n; pass++) {
      last = -1;
      for (let i = 0; i < residual.length; i++) {
        const e = residual[i];
        if (e.cap && distance[e.v] > distance[e.u] + e.cost) { distance[e.v] = distance[e.u] + e.cost; parent[e.v] = i; last = e.v; }
      }
    }
    if (last === -1) break;
    for (let i = 0; i < n; i++) last = residual[parent[last]].u;
    const cycle = []; let v = last;
    do { const i = parent[v]; cycle.push(i); v = residual[i].u; } while (v !== last);
    augment(cycle, Math.min(...cycle.map(i => residual[i].cap)));
  }
  return { flow, cost: edges.reduce((sum, e, i) => sum + (e[2] - residual[i * 2].cap) * e[3], 0) };
}

test('hard network oracle agrees with an independent residual solver, including larger networks', () => {
  for (const [label, [input], expected] of hardTasks[0].checks) assert.deepEqual(residualFlow(input), expected, label);
});

test('canonical merge handles transitive conflicts, boundaries and duplicate-line ties', () => {
  assert.deepEqual(mergeOracle(['a', 'b'], ['A', 'b'], ['a', 'B']), [{ type: 'ok', lines: ['A', 'B'] }]);
  assert.deepEqual(mergeOracle(['a', 'b'], ['x', 'a', 'b'], ['A', 'b']), [{ type: 'ok', lines: ['x', 'A', 'b'] }]);
  assert.deepEqual(mergeOracle(['a', 'b', 'c', 'd'], ['L', 'c', 'd'], ['a', 'R', 'd']), [
    { type: 'conflict', base: ['a', 'b', 'c'], left: ['L', 'c'], right: ['a', 'R'] }, { type: 'ok', lines: ['d'] },
  ]);
  assert.deepEqual(mergeOracle(['x', 'x', 'y'], ['x', 'y'], ['x', 'z', 'y']), [
    { type: 'ok', lines: ['x'] }, { type: 'conflict', base: ['x'], left: [], right: ['z'] }, { type: 'ok', lines: ['y'] },
  ]);
  for (const [, [base, left, right]] of hardTasks[1].checks) {
    const ok = lines => lines.length ? [{ type: 'ok', lines }] : [];
    assert.deepEqual(mergeOracle(base, left, left), ok(left));
    assert.deepEqual(mergeOracle(base, base, right), ok(right));
    assert.deepEqual(mergeOracle(base, left, right), mergeOracle(base, right, left).map(b => b.type === 'conflict' ? { ...b, left: b.right, right: b.left } : b));
  }
});

test('transaction oracle preserves historical conflicts, read-only validation and savepoint reads', () => {
  const commands = [
    { op: 'begin', tx: 'a' }, { op: 'begin', tx: 'b' },
    { op: 'savepoint', tx: 'a', name: 's' }, { op: 'get', tx: 'a', key: 'x' },
    { op: 'put', tx: 'a', key: 'y', value: 'discarded' }, { op: 'rollbackTo', tx: 'a', name: 's' },
    { op: 'put', tx: 'b', key: 'x', value: 'v' }, { op: 'commit', tx: 'b' },
    { op: 'begin', tx: 'b' }, { op: 'delete', tx: 'b', key: 'x' }, { op: 'commit', tx: 'b' },
    { op: 'get', tx: 'a', key: 'x' }, { op: 'commit', tx: 'a' },
    { op: 'begin', tx: 'c' }, { op: 'scan', tx: 'c', prefix: '' }, { op: 'commit', tx: 'c' },
  ];
  assert.deepEqual(transactionOracle(commands), [null, null, null, null, null, null, null,
    { committed: true, version: 1 }, null, null, { committed: true, version: 2 }, null,
    { committed: false, conflicts: ['x'] }, null, [], { committed: true, version: 2 }]);
});

test('hard graders accept references and reject stubs, including payloads larger than argv limits', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi2-hard-grade-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const oracleUrl = new URL('../benchmark/hard-tasks.mjs', import.meta.url).href;
  const solutions = [
    `export const minCostFlow = ${residualFlow.toString()};`,
    `export { mergeOracle as merge3 } from ${JSON.stringify(oracleUrl)};`,
    `export { transactionOracle as simulateTransactions } from ${JSON.stringify(oracleUrl)};`,
  ];
  for (const [i, task] of hardTasks.entries()) {
    await writeFile(join(cwd, task.file), solutions[i]);
    const result = grade(task, cwd); assert.equal(result.allPassed, true, JSON.stringify(result));
    await writeFile(join(cwd, task.file), `export function ${task.name}() { return []; }`);
    assert.equal(grade(task, cwd).allPassed, false);
  }
});

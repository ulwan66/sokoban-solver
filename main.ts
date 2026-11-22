// Sokoban solver: per-room push-optimal A*.
// Rooms are found by removing the hallway (the row/col through the player start);
// each remaining connected component with boxes is a room. Boxes never leave
// their room, so each room is solved independently and the push-optimal total
// is the sum of the rooms' optima.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_EXPAND = 400_000;

type Pt = number; // cell index y*w+x
const DIRS: [number, number, string][] = [[0, -1, 'u'], [0, 1, 'd'], [-1, 0, 'l'], [1, 0, 'r']];

function solve(text: string): string {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const idx = (x: number, y: number) => y * w + x;
  const wall = new Uint8Array(w * h);
  const goals: number[] = [];
  let boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = idx(x, y);
      if (ch === '#') wall[i] = 1;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  const inB = (i: number) => i >= 0 && i < w * h && !wall[i];
  const nbrs = (i: number): number[] => {
    const x = i % w, y = (i / w) | 0, out: number[] = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) { const j = idx(nx, ny); if (!wall[j]) out.push(j); }
    }
    return out;
  };

  // ---- hallway: longest straight floor run through the player ----
  const px = player % w, py = (player / w) | 0;
  let hRun: number[] = []; { let x = px; while (x >= 0 && !wall[idx(x, py)]) x--; const x0 = x + 1; x = px; while (x < w && !wall[idx(x, py)]) x++; const x1 = x - 1; for (let x = x0; x <= x1; x++) hRun.push(idx(x, py)); }
  let vRun: number[] = []; { let y = py; while (y >= 0 && !wall[idx(px, y)]) y--; const y0 = y + 1; y = py; while (y < h && !wall[idx(px, y)]) y++; const y1 = y - 1; for (let y = y0; y <= y1; y++) vRun.push(idx(px, y)); }
  const hall = hRun.length >= vRun.length ? hRun : vRun;
  const hallSet = new Set(hall);

  // ---- rooms: connected components of floor minus hallway ----
  const seen = new Set<number>();
  const rooms: { cells: Set<number>; boxes: number[]; goals: number[]; entry: number[] }[] = [];
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || hallSet.has(i) || seen.has(i)) continue;
    const comp: number[] = []; const st = [i]; seen.add(i);
    while (st.length) { const u = st.pop()!; comp.push(u); for (const v of nbrs(u)) if (!hallSet.has(v) && !seen.has(v)) { seen.add(v); st.push(v); } }
    const rb = comp.filter((c) => boxes.includes(c));
    const rg = comp.filter((c) => goals.includes(c));
    if (rb.length === 0) continue;
    const cellSet = new Set(comp);
    // entry hallway cells adjacent to this room
    const entry: number[] = [];
    for (const c of comp) for (const v of nbrs(c)) if (hallSet.has(v) && !entry.includes(v)) entry.push(v);
    rooms.push({ cells: cellSet, boxes: rb.sort((a, b) => a - b), goals: rg.sort((a, b) => a - b), entry });
  }
  if (rooms.length === 0) return '';

  // ---- helpers shared by room solves ----
  const manhattan = (a: number, b: number) => Math.abs((a % w) - (b % w)) + Math.abs(((a / w) | 0) - ((b / w) | 0));
  // min-cost matching boxes->goals (brute force permutations, n<=4)
  function matchCost(bs: number[], gs: number[]): number {
    const n = bs.length; let best = Infinity;
    const perm = gs.slice();
    const rec = (k: number, cost: number) => {
      if (cost >= best) return;
      if (k === n) { best = cost; return; }
      for (let j = k; j < n; j++) { [perm[k], perm[j]] = [perm[j], perm[k]]; rec(k + 1, cost + manhattan(bs[k], perm[k])); [perm[k], perm[j]] = [perm[j], perm[k]]; }
    };
    rec(0, 0); return best;
  }

  // BFS distances / paths on a domain, treating a set of blocked cells as obstacles
  function bfsPath(from: number, to: number, domain: Set<number>, blocked: Set<number>): string | null {
    if (from === to) return '';
    const prev = new Map<number, [number, string]>();
    const q = [from]; prev.set(from, [-1, '']);
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi]!;
      for (const [dx, dy, ch] of DIRS) {
        const x = u % w, y = (u / w) | 0; const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const v = idx(nx, ny);
        if (!domain.has(v) || blocked.has(v) || prev.has(v)) continue;
        prev.set(v, [u, ch]);
        if (v === to) { let s = ''; let cur = v; while (cur !== from) { const [p, c] = prev.get(cur)!; s = c + s; cur = p; } return s; }
        q.push(v);
      }
    }
    return null;
  }
  function reachableSet(from: number, domain: Set<number>, blocked: Set<number>): Set<number> {
    const out = new Set<number>([from]); const q = [from];
    for (let qi = 0; qi < q.length; qi++) { const u = q[qi]!; for (const v of nbrs(u)) if (domain.has(v) && !blocked.has(v) && !out.has(v)) { out.add(v); q.push(v); } }
    return out;
  }

  // ---- solve one room push-optimally ----
  function solveRoom(room: { cells: Set<number>; boxes: number[]; goals: number[]; entry: number[] }, startPlayer: number): { moves: string; endPlayer: number } | null {
    const domain = new Set<number>([...room.cells, ...room.entry]);
    const goalSet = new Set(room.goals);
    // dead cells: reverse pull reachability from goals
    const live = new Set<number>(room.goals);
    { let changed = true;
      while (changed) { changed = false;
        for (const c of [...live]) for (const [dx, dy] of DIRS) {
          const p = c - (dy * w + dx); // cell a box is pushed FROM to reach c
          const behind = p - (dy * w + dx); // where the player stands
          if (!room.cells.has(p) || live.has(p)) continue;
          if (domain.has(behind) && !wall[behind]) { live.add(p); changed = true; }
        }
      } }
    const dead = new Set<number>([...room.cells].filter((c) => !live.has(c)));
    const isDead2x2 = (bs: number[]): boolean => {
      const s = new Set(bs);
      for (const b of bs) {
        const x = b % w, y = (b / w) | 0;
        for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
          const cells = [idx(x + ox, y + oy), idx(x + ox + 1, y + oy), idx(x + ox, y + oy + 1), idx(x + ox + 1, y + oy + 1)];
          if (cells.some((c) => c < 0 || c >= w * h)) continue;
          if (cells.every((c) => wall[c] || s.has(c)) && !cells.some((c) => goalSet.has(c))) return true;
        }
      }
      return false;
    };
    const canon = (p: number, bs: number[]): number => {
      const blocked = new Set(bs);
      const r = reachableSet(p, domain, blocked);
      let m = Infinity; for (const c of r) if (c < m) m = c; return m;
    };
    // A* over pushes. Node arrays.
    const nP: number[] = [startPlayer];
    const nB: number[][] = [room.boxes.slice()];
    const nG: number[] = [0];
    const nPar: number[] = [-1];
    const nMove: string[] = [''];
    const nCanon: number[] = [canon(startPlayer, room.boxes)];
    const best = new Map<string, number>();
    const keyOf = (c: number, bs: number[]) => c + '|' + bs.join(',');
    best.set(keyOf(nCanon[0]!, nB[0]!), 0);
    const heap: [number, number][] = [[matchCost(room.boxes, room.goals), 0]]; // [f, node]
    const hLess = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const hPush = (e: [number, number]) => { let i = heap.length; heap.push(e); while (i > 0) { const p = (i - 1) >> 1; if (!hLess(heap[i]!, heap[p]!)) break; [heap[i], heap[p]] = [heap[p]!, heap[i]!]; i = p; } };
    const hPop = (): [number, number] => { const top = heap[0]!; const last = heap.pop()!; if (heap.length) { heap[0] = last; for (let i = 0; ;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && hLess(heap[c + 1]!, heap[c]!)) c++; if (!hLess(heap[c]!, heap[i]!)) break; [heap[i], heap[c]] = [heap[c]!, heap[i]!]; i = c; } } return top; };
    let expanded = 0;
    let bestGoal: number | null = null;
    while (heap.length && expanded < MAX_EXPAND) {
      const [, s] = hPop();
      if (best.get(keyOf(nCanon[s]!, nB[s]!)) !== s) continue;
      const bs = nB[s]!; const p = nP[s]!;
      if (bs.every((b) => goalSet.has(b))) {
        // can the player reach the hallway from here?
        const blocked = new Set(bs);
        const r = reachableSet(p, domain, blocked);
        if ([...r].some((c) => room.entry.includes(c))) { bestGoal = s; break; }
      }
      expanded++;
      const blocked = new Set(bs);
      for (let bi = 0; bi < bs.length; bi++) {
        const b = bs[bi]!;
        for (const [dx, dy, ch] of DIRS) {
          const target = b + dy * w + dx;
          const from = b - (dy * w + dx);
          if (!room.cells.has(target) || blocked.has(target)) continue;
          if (!domain.has(from) || blocked.has(from)) continue;
          const walk = bfsPath(p, from, domain, blocked);
          if (walk === null) continue;
          const nb = bs.slice(); nb[bi] = target; nb.sort((a, b) => a - b);
          if (nb.some((x) => dead.has(x))) continue;
          if (isDead2x2(nb)) continue;
          const nc = canon(b, nb);
          const k = keyOf(nc, nb);
          const prev = best.get(k);
          if (prev !== undefined && nG[prev]! <= nG[s]! + 1) continue;
          const t = nP.length;
          nP.push(b); nB.push(nb); nG.push(nG[s]! + 1); nPar.push(s); nMove.push(walk + ch);
          nCanon.push(nc); best.set(k, t);
          hPush([nG[t]! + matchCost(nb, room.goals), t]);
        }
      }
    }
    if (bestGoal === null) return null;
    let moves = '';
    for (let t = bestGoal; t > 0; t = nPar[t]!) moves = nMove[t] + moves;
    return { moves, endPlayer: nP[bestGoal]! };
  }

  // ---- stitch rooms ----
  // order rooms: nearest first from the player (greedy by hallway distance)
  let cur = player;
  let out = '';
  const remaining = rooms.slice();
  // helper: walk the player (no pushes) from cur to a target cell, boxes as obstacles
  const walkTo = (target: number, boxSet: number[]): string | null => {
    const domain = new Set<number>();
    for (let i = 0; i < w * h; i++) if (!wall[i]) domain.add(i);
    const blocked = new Set(boxSet);
    return bfsPath(cur, target, domain, blocked);
  };
  while (remaining.length) {
    // pick the room whose entry is closest (hallway walk)
    let bi = -1, bWalk = '', bEntry = -1;
    for (let i = 0; i < remaining.length; i++) {
      for (const e of remaining[i]!.entry) {
        const wk = walkTo(e, boxes);
        if (wk !== null && (bi < 0 || wk.length < bWalk.length)) { bi = i; bWalk = wk; bEntry = e; }
      }
    }
    if (bi < 0) return ''; // cannot reach any room
    const room = remaining.splice(bi, 1)[0]!;
    out += bWalk; cur = bEntry;
    const res = solveRoom(room, cur);
    if (!res) return ''; // room unsolved -> empty (no points) rather than wrong
    out += res.moves; cur = res.endPlayer;
    // exit to the hallway: walk from cur to nearest hallway cell
    const blocked = new Set(boxes);
    // boxes in solved rooms are on goals; boxes in unsolved rooms still at start.
    // For the exit walk, treat ALL current boxes as obstacles; recompute box positions:
    // solved rooms' boxes are on their goals; remaining rooms' boxes are initial.
    const curBoxes: number[] = [];
    for (const r of rooms) curBoxes.push(...r.boxes);
    for (const r of remaining) curBoxes.push(...r.boxes);
    // (rooms already solved contribute their goals)
    const solvedBoxes: number[] = [];
    // simpler: use all boxes from the original set, but solved ones are on goals.
    // We track solved goals instead:
    const allBlocked = new Set<number>();
    for (const g of goals) allBlocked.add(g); // solved boxes sit on goals; unsolved boxes at initial spots
    for (const r of remaining) for (const b of r.boxes) allBlocked.add(b);
    const domain = new Set<number>();
    for (let i = 0; i < w * h; i++) if (!wall[i]) domain.add(i);
    // find nearest hallway cell reachable
    let exitWalk: string | null = null;
    // BFS from cur over domain avoiding allBlocked, stop at any hall cell
    const prev = new Map<number, [number, string]>();
    const q = [cur]; prev.set(cur, [-1, '']);
    let found = -1;
    for (let qi = 0; qi < q.length && found < 0; qi++) {
      const u = q[qi]!;
      if (hallSet.has(u) && u !== cur) { found = u; break; }
      for (const [dx, dy, ch] of DIRS) {
        const x = u % w, y = (u / w) | 0; const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const v = idx(nx, ny);
        if (!domain.has(v) || allBlocked.has(v) || prev.has(v)) continue;
        prev.set(v, [u, ch]); q.push(v);
      }
    }
    if (found >= 0) { let s = ''; let c2 = found; while (c2 !== cur) { const [pp, cc] = prev.get(c2)!; s = cc + s; c2 = pp; } exitWalk = s; cur = found; }
    if (exitWalk !== null) out += exitWalk;
    // mark this room's boxes as solved (they are on goals now)
    boxes = boxes.filter((b) => !room.boxes.includes(b));
  }
  return out;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

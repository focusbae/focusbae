// Force layout for the workspace graph, kept apart from the drawing so its
// behaviour can be measured rather than eyeballed.
export const WIDTH = 900;
export const HEIGHT = 620;
// Repulsion is every-pair, so the tick budget shrinks as the graph grows: a big
// workspace still lays out in well under a second on one pass.
const ticksFor = (count) => (count <= 120 ? 320 : count <= 300 ? 160 : 80);

// One page and what it touches, within `depth` steps. A whole-workspace graph
// answers "what does this look like"; this answers "what is this page connected
// to", which is the question someone reading that page actually has.
export function neighbourhood({ nodes, edges }, id, depth = 1) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(id)) return { nodes: [], edges: [] };
  const kept = new Set([id]);
  let frontier = [id];
  for (let step = 0; step < depth; step++) {
    const next = [];
    for (const edge of edges) {
      if (frontier.includes(edge.from) && !kept.has(edge.to)) {
        kept.add(edge.to);
        next.push(edge.to);
      }
      if (frontier.includes(edge.to) && !kept.has(edge.from)) {
        kept.add(edge.from);
        next.push(edge.from);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return {
    nodes: nodes.filter((node) => kept.has(node.id)),
    edges: edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
  };
}

// Deterministic: the same workspace always draws the same picture, so the graph
// is something you can learn the shape of rather than a new arrangement each visit.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function layout({ nodes, edges }) {
  const next = random(nodes.length + 1);
  const points = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    const spread = 120 + next() * 200;
    return {
      ...node,
      x: WIDTH / 2 + Math.cos(angle) * spread,
      y: HEIGHT / 2 + Math.sin(angle) * spread,
      vx: 0,
      vy: 0,
      degree: 0,
    };
  });
  const index = new Map(points.map((point) => [point.id, point]));
  const springs = edges
    .map((edge) => ({ ...edge, a: index.get(edge.from), b: index.get(edge.to) }))
    .filter((spring) => spring.a && spring.b);
  for (const spring of springs) {
    spring.a.degree += 1;
    spring.b.degree += 1;
  }
  const ticks = ticksFor(points.length);
  for (let tick = 0; tick < ticks; tick++) {
    const cooling = 1 - tick / ticks;
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = 0.1;
          dy = 0.1;
          distance = 0.14;
        }
        const push = (12000 / (distance * distance)) * cooling;
        a.vx += (dx / distance) * push;
        a.vy += (dy / distance) * push;
        b.vx -= (dx / distance) * push;
        b.vy -= (dy / distance) * push;
      }
    for (const spring of springs) {
      const dx = spring.b.x - spring.a.x;
      const dy = spring.b.y - spring.a.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const pull = ((distance - 70) / distance) * 0.08 * cooling;
      spring.a.vx += dx * pull;
      spring.a.vy += dy * pull;
      spring.b.vx -= dx * pull;
      spring.b.vy -= dy * pull;
    }
    for (const point of points) {
      point.vx += (WIDTH / 2 - point.x) * 0.002;
      point.vy += (HEIGHT / 2 - point.y) * 0.002;
      point.x += Math.max(-18, Math.min(18, point.vx));
      point.y += Math.max(-18, Math.min(18, point.vy));
      point.vx *= 0.82;
      point.vy *= 0.82;
    }
  }
  return { points: fit(points), springs };
}

// The simulation decides the shape; this decides the size. Scaling the settled
// cloud onto one canvas means a node, its label and the gaps between them are the
// same size in a notebook of six pages and one of six hundred — the zoom control
// is what changes that, not how much you have written.
function fit(points) {
  const pad = 70;
  if (points.length < 2) {
    for (const point of points) {
      point.x = WIDTH / 2;
      point.y = HEIGHT / 2;
    }
    return points;
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const spread = Math.max(
    1,
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
  const scale = (Math.min(WIDTH, HEIGHT) - pad * 2) / spread;
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const point of points) {
    point.x = WIDTH / 2 + (point.x - midX) * scale;
    point.y = HEIGHT / 2 + (point.y - midY) * scale;
  }
  return points;
}

// The canvas is fixed, because the layout is already scaled onto it.
export function frame() {
  return { x: 0, y: 0, width: WIDTH, height: HEIGHT };
}

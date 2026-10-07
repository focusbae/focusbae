"use strict";
// The graph layout is arithmetic, so it is checked as arithmetic: the same
// workspace draws the same picture, the picture always fits the canvas, and a
// large notebook still lays out in one pass without blocking the window.
const test = require("node:test");
const assert = require("node:assert/strict");

const graph = (count, { connect = true } = {}) => ({
  nodes: Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    kind: "note",
    label: `Page ${index}`,
  })),
  edges: connect
    ? Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
        from: `n${index}`,
        to: `n${index + 1}`,
        kind: "links",
      }))
    : [],
  truncated: false,
});

test("the workspace graph is laid out inside the canvas, the same way every time", async () => {
  const { layout, frame, WIDTH, HEIGHT } = await import(
    "../../desktop-ui/src/graph-layout.mjs"
  );
  assert.deepEqual(frame(), { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const inside = (points) =>
    points.every(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= WIDTH &&
        point.y >= 0 &&
        point.y <= HEIGHT,
    );
  // One page has nowhere to go but the middle; two have nothing to collide with.
  assert.deepEqual(layout(graph(1)).points.map((point) => [point.x, point.y]), [
    [WIDTH / 2, HEIGHT / 2],
  ]);
  for (const count of [2, 6, 40, 200]) {
    const { points, springs } = layout(graph(count));
    assert.equal(points.length, count);
    assert.equal(springs.length, count - 1);
    assert.ok(inside(points), `${count} nodes stay on the canvas`);
    // A handful of pages fills the canvas rather than huddling in the middle.
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    assert.ok(
      Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ) >
        HEIGHT / 2,
      `${count} nodes use the canvas they are given`,
    );
    const again = layout(graph(count)).points;
    assert.deepEqual(
      points.map((point) => [point.x, point.y]),
      again.map((point) => [point.x, point.y]),
      "the same workspace lays out identically",
    );
  }
  // Nothing joined: the nodes must still separate instead of stacking.
  const loose = layout(graph(12, { connect: false })).points;
  assert.ok(inside(loose));
  assert.ok(
    loose.every((point, index) =>
      loose
        .slice(index + 1)
        .every((other) => Math.hypot(point.x - other.x, point.y - other.y) > 8),
    ),
    "unconnected pages do not land on top of each other",
  );
  // An edge naming a node that is not drawn is dropped, not rendered as NaN.
  const partial = layout({
    nodes: [{ id: "a", kind: "note", label: "A" }],
    edges: [{ from: "a", to: "missing", kind: "links" }],
  });
  assert.equal(partial.springs.length, 0);
  const started = Date.now();
  const big = layout(graph(600));
  assert.ok(inside(big.points));
  assert.ok(
    Date.now() - started < 3000,
    "a full-size graph lays out in one pass without freezing the window",
  );
});

test("one page's neighbourhood is the page and what it touches", async () => {
  const { neighbourhood } = await import("../../desktop-ui/src/graph-layout.mjs");
  const world = {
    nodes: ["a", "b", "c", "d", "island"].map((id) => ({ id, kind: "note", label: id })),
    edges: [
      { from: "a", to: "b", kind: "links" },
      { from: "c", to: "a", kind: "links" },
      { from: "b", to: "d", kind: "links" },
    ],
  };
  const ids = (result) => result.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids(neighbourhood(world, "a")), ["a", "b", "c"]);
  assert.deepEqual(
    neighbourhood(world, "a").edges.map((edge) => `${edge.from}->${edge.to}`).sort(),
    ["a->b", "c->a"],
    "an edge is kept only when both of its ends are drawn",
  );
  assert.deepEqual(
    ids(neighbourhood(world, "a", 2)),
    ["a", "b", "c", "d"],
    "a second step reaches what the neighbours touch",
  );
  assert.deepEqual(ids(neighbourhood(world, "island")), ["island"]);
  assert.deepEqual(neighbourhood(world, "missing"), { nodes: [], edges: [] });
  // A neighbourhood is a graph, so it lays out like one.
  const { layout } = await import("../../desktop-ui/src/graph-layout.mjs");
  assert.equal(layout(neighbourhood(world, "a")).points.length, 3);
});


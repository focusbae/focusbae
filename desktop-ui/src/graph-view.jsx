import React, { useEffect, useMemo, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { layout, frame, neighbourhood } from "./graph-layout.mjs";
import "./graph-view.css";

// The workspace graph. Layout is a small force simulation run to completion once,
// not per frame: a few hundred nodes settle in a few milliseconds and the result
// is a static SVG, which keeps a long-lived window from spending battery on an
// animation nobody is watching.
const KINDS = {
  note: { label: "Notes", radius: 8 },
  person: { label: "People", radius: 10 },
  recording: { label: "Recordings", radius: 8 },
  action: { label: "Actions", radius: 7 },
};
export function GraphView({ graph, open, focusId }) {
  const [hidden, setHidden] = useState(() => new Set());
  const [hover, setHover] = useState(null);
  const [zoom, setZoom] = useState(1);
  // Opened from a page: start on that page's connections, with the whole
  // workspace one click away.
  const [focusOnly, setFocusOnly] = useState(!!focusId);
  useEffect(() => setFocusOnly(!!focusId), [focusId]);
  const drawn = useMemo(
    () => (focusOnly && focusId ? neighbourhood(graph, focusId) : graph),
    [graph, focusId, focusOnly],
  );
  const { points, springs } = useMemo(() => layout(drawn), [drawn]);
  const visible = points.filter((point) => !hidden.has(point.kind));
  const shown = new Set(visible.map((point) => point.id));
  const box = frame();
  const counts = points.reduce((all, point) => {
    all[point.kind] = (all[point.kind] ?? 0) + 1;
    return all;
  }, {});
  const focused = hover ?? focusId ?? null;
  const near = useMemo(() => {
    if (!focused) return null;
    const set = new Set([focused]);
    for (const spring of springs) {
      if (spring.from === focused) set.add(spring.to);
      if (spring.to === focused) set.add(spring.from);
    }
    return set;
  }, [focused, springs]);
  return (
    <section className="graph-view" aria-label="Workspace graph">
      <div className="graph-controls">
        {Object.entries(KINDS).map(([kind, { label }]) => (
          <label key={kind} className={hidden.has(kind) ? "off" : ""}>
            <input
              type="checkbox"
              checked={!hidden.has(kind)}
              onChange={() =>
                setHidden((old) => {
                  const next = new Set(old);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  return next;
                })
              }
            />
            <span className={`dot ${kind}`} />
            {label}
            <span className="graph-count">{counts[kind] ?? 0}</span>
          </label>
        ))}
        {focusId && (
          <label className="graph-focus">
            <input
              type="checkbox"
              checked={focusOnly}
              onChange={() => setFocusOnly(!focusOnly)}
            />
            Only this page
          </label>
        )}
        <span className="toolbar-space" />
        <span className="graph-zoom">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          >
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Reset zoom"
            onClick={() => setZoom(1)}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
          >
            <ZoomIn size={16} />
          </button>
        </span>
      </div>
      {!visible.length ? (
        <p className="graph-empty">
          {focusOnly && focusId
            ? "This page is not connected to anything yet. Write [[a name]] in it, or save a recording into it."
            : "Nothing connected yet. Write [[a name]] in a note, or record a conversation, and the links show up here."}
        </p>
      ) : (
        <div className="graph-canvas">
          <svg
            viewBox={`${box.x + (box.width * (1 - 1 / zoom)) / 2} ${box.y + (box.height * (1 - 1 / zoom)) / 2} ${box.width / zoom} ${box.height / zoom}`}
            aria-label={`${visible.length} connected items`}
          >
            {springs
              .filter(
                (spring) => shown.has(spring.from) && shown.has(spring.to),
              )
              .map((spring, index) => (
                <line
                  key={index}
                  className={`graph-edge ${spring.kind} ${near && !(near.has(spring.from) && near.has(spring.to)) ? "faded" : ""}`}
                  x1={spring.a.x}
                  y1={spring.a.y}
                  x2={spring.b.x}
                  y2={spring.b.y}
                />
              ))}
            {visible.map((point) => (
              <g
                key={point.id}
                className={`graph-node ${point.kind} ${near && !near.has(point.id) ? "faded" : ""} ${point.id === focusId ? "current" : ""}`}
                onMouseEnter={() => setHover(point.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => open(point)}
                tabIndex={0}
                role="button"
                aria-label={`${point.kind}: ${point.label}`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open(point);
                  }
                }}
              >
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={
                    KINDS[point.kind].radius +
                    Math.min(5, Math.sqrt(point.degree))
                  }
                />
                <text x={point.x} y={point.y - 15}>
                  {point.label.length > 28
                    ? `${point.label.slice(0, 27)}...`
                    : point.label}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      {graph.truncated && (
        <p className="graph-note">
          Showing the most connected items only — this workspace has more than
          the graph draws.
        </p>
      )}
    </section>
  );
}

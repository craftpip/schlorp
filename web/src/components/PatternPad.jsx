import { useRef, useState } from "react";

// Android-style pattern pad (plan 040). Grid 3x3 / 4x4 / 5x5, mouse + touch.
// Passing straight over a dot includes it (like Android). `onComplete` gets
// { size, dots } and may return a promise: resolve → green flash, reject →
// red flash; either way the pad clears for the next try.
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));

export default function PatternPad({ size = 3, onComplete, disabled = false, px = 240, minDots = 4, hint, testId = "pattern-pad" }) {
  const [dots, setDots] = useState([]);
  const [pointer, setPointer] = useState(null);
  const [state, setState] = useState("idle"); // idle | drawing | busy | ok | error
  const [msg, setMsg] = useState("");
  const svgRef = useRef(null);
  const drawing = useRef(false);
  const dotsRef = useRef([]);

  const n = size;
  const pad = 14;
  const step = (100 - 2 * pad) / (n - 1);
  const pos = (i) => ({ x: pad + (i % n) * step, y: pad + Math.floor(i / n) * step });
  const hitR = step * 0.32;

  const toLocal = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };

  const addDot = (i) => {
    const cur = dotsRef.current;
    if (cur.includes(i)) return;
    const next = [...cur];
    if (cur.length) {
      // Include grid dots lying exactly between the last dot and this one.
      const a = cur[cur.length - 1];
      const ax = a % n, ay = Math.floor(a / n), bx = i % n, by = Math.floor(i / n);
      const g = gcd(bx - ax, by - ay);
      for (let k = 1; k < g; k++) {
        const mid = (ay + ((by - ay) / g) * k) * n + (ax + ((bx - ax) / g) * k);
        if (!next.includes(mid)) next.push(mid);
      }
    }
    next.push(i);
    dotsRef.current = next;
    setDots(next);
  };

  const hitTest = (p) => {
    for (let i = 0; i < n * n; i++) {
      const d = pos(i);
      if ((d.x - p.x) ** 2 + (d.y - p.y) ** 2 <= hitR * hitR) return i;
    }
    return -1;
  };

  const flash = (kind, text) => {
    setState(kind);
    setMsg(text || "");
    setTimeout(() => {
      dotsRef.current = [];
      setDots([]);
      setState("idle");
    }, kind === "error" ? 900 : 500);
  };

  const onDown = (e) => {
    if (disabled || state === "busy") return;
    e.preventDefault();
    try { svgRef.current.setPointerCapture(e.pointerId); } catch {}
    drawing.current = true;
    dotsRef.current = [];
    setDots([]);
    setMsg("");
    setState("drawing");
    const p = toLocal(e);
    setPointer(p);
    const hit = hitTest(p);
    if (hit >= 0) addDot(hit);
  };
  const onMove = (e) => {
    if (!drawing.current) return;
    const p = toLocal(e);
    setPointer(p);
    const hit = hitTest(p);
    if (hit >= 0) addDot(hit);
  };
  const onUp = async () => {
    if (!drawing.current) return;
    drawing.current = false;
    setPointer(null);
    const seq = dotsRef.current;
    if (!seq.length) { setState("idle"); return; }
    if (seq.length < minDots) { flash("error", `Connect at least ${minDots} dots`); return; }
    setState("busy");
    try {
      await (onComplete && onComplete({ size: n, dots: seq }));
      flash("ok");
    } catch (err) {
      flash("error", (err && err.message) || "Try again");
    }
  };

  const tone = state === "error" ? "#f87171" : state === "ok" ? "#10b981" : "#6366f1";
  const line = dots.map((i) => pos(i));
  const last = line[line.length - 1];
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, userSelect: "none", WebkitUserSelect: "none" }}>
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        width={px}
        height={px}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        style={{ touchAction: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, background: "var(--surface-2)", borderRadius: 14, border: "1px solid var(--border)", maxWidth: "100%" }}
      >
        {line.length > 1 && <polyline points={line.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={tone} strokeWidth={n >= 5 ? 1.6 : 2.2} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />}
        {last && pointer && state === "drawing" && <line x1={last.x} y1={last.y} x2={pointer.x} y2={pointer.y} stroke={tone} strokeWidth={n >= 5 ? 1.2 : 1.8} strokeLinecap="round" opacity={0.5} />}
        {Array.from({ length: n * n }, (_, i) => {
          const p = pos(i);
          const on = dots.includes(i);
          return (
            <g key={i}>
              {on && <circle cx={p.x} cy={p.y} r={hitR * 0.9} fill={tone} opacity={0.18} />}
              <circle cx={p.x} cy={p.y} r={on ? (n >= 5 ? 2.6 : 3.4) : n >= 5 ? 1.8 : 2.4} fill={on ? tone : "var(--muted)"} />
            </g>
          );
        })}
      </svg>
      <div style={{ minHeight: 16, fontSize: 11.5, color: state === "error" ? "#f87171" : "var(--muted)", textAlign: "center" }}>
        {state === "busy" ? "Checking…" : msg || hint || ""}
      </div>
    </div>
  );
}

// Draw-twice setup helper: resolves the confirmed pattern via onDone.
export function PatternSetup({ size, onDone, px = 220, minDots = 4 }) {
  const [first, setFirst] = useState(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{first ? "Draw it again to confirm" : "Draw your new pattern"}</div>
      <PatternPad
        key={`${size}-${first ? "confirm" : "first"}`}
        size={size}
        px={px}
        minDots={minDots}
        hint={first ? "" : `At least ${minDots} dots`}
        testId={first ? "pattern-setup-confirm" : "pattern-setup-first"}
        onComplete={async (p) => {
          if (!first) { setFirst(p); return; }
          if (first.dots.join(".") !== p.dots.join(".")) { setFirst(null); throw new Error("Patterns didn't match — start over"); }
          onDone(p);
        }}
      />
      {first && <button type="button" className="btn btn-sm btn-link" style={{ fontSize: 11 }} onClick={() => setFirst(null)}>Start over</button>}
    </div>
  );
}

import { useEffect } from "react";

export default function AlertModal({ open, title = "Notice", message, buttonLabel = "OK", onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") onClose && onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      data-testid="alert-modal"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 90, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(6,8,18,0.55)", backdropFilter: "blur(6px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.25)", overflow: "hidden" }}
      >
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{title}</div>
          {message && <div style={{ marginTop: 8, fontSize: 13, color: "var(--muted)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{message}</div>}
        </div>
        <div style={{ padding: 12, display: "flex", justifyContent: "flex-end", background: "var(--surface-2)" }}>
          <button data-testid="alert-modal-ok" className="btn btn-sm btn-primary" onClick={onClose} style={{ padding: "6px 14px" }}>
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect } from "react";

export default function ConfirmModal({ open, title = "Confirm", message, confirmLabel = "Confirm", cancelLabel = "Cancel", onConfirm, onCancel, danger = false, singleButton = false }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && onCancel && !singleButton) onCancel();
      if (e.key === "Enter" && onConfirm) onConfirm();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onConfirm, onCancel, singleButton]);

  if (!open) return null;
  return (
    <div
      data-testid="confirm-modal"
      onClick={onCancel && !singleButton ? onCancel : undefined}
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
        <div style={{ padding: 12, display: "flex", gap: 8, justifyContent: "flex-end", background: "var(--surface-2)" }}>
          {!singleButton && (
            <button data-testid="confirm-modal-cancel" className="btn btn-sm btn-outline-secondary" onClick={onCancel} style={{ padding: "6px 14px" }}>
              {cancelLabel}
            </button>
          )}
          <button
            data-testid="confirm-modal-confirm"
            className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            style={{ padding: "6px 14px" }}
          >
            {singleButton ? "OK" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

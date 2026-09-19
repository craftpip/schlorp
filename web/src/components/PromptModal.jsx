import { useEffect, useState, useRef } from "react";

export default function PromptModal({ open, title = "Enter value", message, placeholder = "", defaultValue = "", confirmLabel = "Save", cancelLabel = "Cancel", onConfirm, onCancel, maxLength = 60 }) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e) => {
      if (e.key === "Escape" && onCancel) onCancel();
      if ((e.key || "").toLowerCase() === "q" && onCancel) {
        const typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
        if (!typing) onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const v = String(value || "").trim();
    if (!v) return;
    onConfirm && onConfirm(v);
  };

  return (
    <div
      data-testid="prompt-modal"
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(6,8,18,0.55)", backdropFilter: "blur(6px)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 420, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, boxShadow: "0 12px 32px rgba(0,0,0,.25)", overflow: "hidden" }}
      >
        <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{title}</div>
          {message && <div style={{ marginTop: 8, fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{message}</div>}
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            ref={inputRef}
            data-testid="prompt-modal-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            maxLength={maxLength}
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 13 }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" data-testid="prompt-modal-cancel" className="btn btn-sm btn-outline-secondary" onClick={onCancel} style={{ padding: "6px 14px" }}>
              {cancelLabel}
            </button>
            <button type="submit" data-testid="prompt-modal-confirm" className="btn btn-sm btn-primary" disabled={!String(value || "").trim()} style={{ padding: "6px 14px" }}>
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

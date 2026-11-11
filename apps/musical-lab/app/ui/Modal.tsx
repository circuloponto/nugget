"use client";

import { X } from "lucide-react";
import { IC, IC_SM } from "./icons";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** "wide" for tables and charts, "narrow" for short forms. */
  size?: "narrow" | "normal" | "wide";
  testId?: string;
  /** Buttons shown in the footer, right-aligned. */
  footer?: ReactNode;
}

/**
 * A modal dialog: closes on Escape or a click outside, takes focus when it opens and gives it back when it closes.
 * It is rendered into document.body, so it is never clipped by a panel that scrolls.
 */
export default function Modal({ open, title, onClose, children, size = "normal", testId, footer }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      before?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-testid={testId ? `${testId}-backdrop` : undefined}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} tabIndex={-1} ref={ref} data-testid={testId}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" data-testid={testId ? `${testId}-close` : undefined}>
            <X {...IC} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

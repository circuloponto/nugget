"use client";

import type { ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  testId?: string;
}

/** A row of tab buttons (pill style). The caller shows the matching panel. */
export default function Tabs<T extends string>({ tabs, value, onChange, label, className = "" }: { tabs: readonly TabDef<T>[]; value: T; onChange: (id: T) => void; label: string; className?: string }) {
  return (
    <div className={`tabs ${className}`} role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "on" : ""} onClick={() => onChange(t.id)} data-testid={t.testId}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

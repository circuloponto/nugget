"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ShellContextValue {
  /** The element in the top bar where the active view puts its own tools (transport, tempo, file buttons). */
  slot: HTMLElement | null;
}

export const ShellContext = createContext<ShellContextValue>({ slot: null });
export const useShell = () => useContext(ShellContext);

/** Renders its children into the top bar, but only while its view is the active one. */
export function Topbar({ active, children }: { active: boolean; children: ReactNode }) {
  const { slot } = useShell();
  if (!active || !slot) return null;
  return createPortal(children, slot);
}

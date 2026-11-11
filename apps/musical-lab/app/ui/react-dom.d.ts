// The app uses only createPortal from react-dom; declaring it here avoids adding @types/react-dom as a dependency.
declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";
  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactPortal;
}

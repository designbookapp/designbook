import { createContext, useContext, type ReactNode } from "react";

type FlagsValue = {
  tenant: string;
  flags: Record<string, unknown>;
};

const FlagsContext = createContext<FlagsValue>({ tenant: "", flags: {} });

/**
 * Provides the active tenant's feature flags to the subtree. On the designbook
 * canvas the values come from the flags adapter (live, optimistic on edit); in
 * the real app you'd feed them from your flag service.
 */
function FlagsProvider({
  tenant,
  flags,
  children,
}: FlagsValue & { children: ReactNode }) {
  return (
    <FlagsContext value={{ tenant, flags }}>{children}</FlagsContext>
  );
}

function useFlags(): FlagsValue {
  return useContext(FlagsContext);
}

export { FlagsProvider, useFlags };

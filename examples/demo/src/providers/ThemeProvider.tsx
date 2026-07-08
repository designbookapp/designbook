import { createContext, useContext, useState, type ReactNode } from "react";

type ThemeContextValue = {
  /** Brand name rendered in composed screens (e.g. detail-section footer). */
  brandName: string;
  /** Density affects composite spacing; components read it instead of props. */
  density: "comfortable" | "compact";
  setDensity: (density: "comfortable" | "compact") => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function ThemeProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  return (
    <ThemeContext
      value={{ brandName: "Voyager Outfitters", density, setDensity }}
    >
      {children}
    </ThemeContext>
  );
}

function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside a ThemeProvider.");
  }
  return value;
}

export { ThemeProvider, useTheme };

"use client";
import { createContext, useContext, useEffect, useState } from "react";

interface ThemeContextType {
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
export const useTheme = () => useContext(ThemeContext)!;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(true); // Default dark

  useEffect(() => {
    // Sirf localStorage check karo, OS setting ko bhool mat karo
    const savedTheme = localStorage.getItem("osystic_theme");
    if (savedTheme === "light") {
      setIsDark(false);
    } else {
      setIsDark(true);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      localStorage.setItem("osystic_theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("osystic_theme", "light");
    }
  }, [isDark]);

  const toggleTheme = () => setIsDark((prev) => !prev);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
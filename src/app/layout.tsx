import type { Metadata } from "next";
import { AuthProvider } from "@/context/AuthContext";
import { ThemeProvider } from "next-themes";
// @ts-ignore
import "./globals.css";

export const metadata: Metadata = {
  title: "Osystic Finance",
  description: "Finance Management System",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-gray-100 text-gray-900 dark:bg-gray-900 dark:text-gray-50 transition-colors duration-300">
        <ThemeProvider attribute="class">
          <AuthProvider>
            {children}
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
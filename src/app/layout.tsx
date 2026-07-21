import './globals.css'
import { Inter } from 'next/font/google'
import { AuthProvider } from '@/context/AuthContext'
import { ThemeProvider } from '@/context/ThemeContext' 
import { PermissionProvider } from "@/context/PermissionContext";

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'Osystic Finance',
  description: 'Finance Management System',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-white transition-colors duration-300">
        <ThemeProvider>
          <AuthProvider>
            <PermissionProvider>
              {children}
            </PermissionProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
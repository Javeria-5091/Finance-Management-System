import './globals.css'
import { Inter } from 'next/font/google'
import { AuthProvider } from '@/context/AuthContext'
import { ThemeProvider } from '@/context/ThemeContext' 
import { PermissionProvider } from "@/context/PermissionContext";
import QueryProvider from '@/providers/QueryProvider';
import { Toaster } from 'react-hot-toast';
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
              <QueryProvider>
              {children}
              <Toaster 
                position="top-right" 
                toastOptions={{
                  duration: 3000,
                  style: { background: '#363636', color: '#fff', fontSize: '14px' },
                }}
              />
              </QueryProvider>
            </PermissionProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
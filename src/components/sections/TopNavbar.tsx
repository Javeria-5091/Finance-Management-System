"use client"; 
import { useState, useEffect } from "react"; 
// Search hata diya, MessageSquare hata ke Sparkles laga diya
import { Menu, Bell, Sun, Moon, Sparkles } from "lucide-react"; 
import { useAuth } from "@/context/AuthContext"; 
import { useTheme } from "@/context/ThemeContext"; 
import { supabase } from "@/lib/supabase"; 
import type { Notification } from "@/types"; 
import { useRouter } from "next/navigation";
import AiChatSlideOver from "../ai/AiChatSlideOver"; 

interface TopNavbarProps { 
  onMenuClick: () => void; 
  title: string; 
  isDark: boolean;      
  toggleTheme: () => void;
} 

export default function TopNavbar({ onMenuClick, title }: TopNavbarProps) { 
  const { user } = useAuth(); 
  const router = useRouter(); 
  const { isDark, toggleTheme } = useTheme(); 
  const [isChatOpen, setIsChatOpen] = useState(false);
  
  const [notifications, setNotifications] = useState<Notification[]>([]); 
  const [showDropdown, setShowDropdown] = useState(false); 
  const [unreadCount, setUnreadCount] = useState(0); 

  useEffect(() => {
    if (!user) return;
    const userId = user.id;
    async function fetchNotifications() {
      try {
        const { data } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10);
        if (data) {
          setNotifications(data);
          setUnreadCount(data.filter(n => !n.is_read).length);
        }
      } catch (err) {
        console.error("Notifications error:", err);
      }
    }
    fetchNotifications();
  }, [user]); 

  async function markAsRead(notifId: string) { 
    await supabase.from("notifications").update({ is_read: true }).eq("id", notifId); 
    setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, is_read: true } : n)); 
    setUnreadCount(prev => Math.max(0, prev - 1)); 
  } 

  async function markAllAsRead() { 
    if (!user || !user.id) return; 
    await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("is_read", false); 
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true }))); 
    setUnreadCount(0); 
  } 

  function timeAgo(dateStr: string) { 
    const now = new Date(); 
    const date = new Date(dateStr); 
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000); 
    if (seconds < 60) return "Just now"; 
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; 
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; 
    return `${Math.floor(seconds / 86400)}d ago`; 
  } 

  return ( 
    <> 
      <header className={`sticky top-0 z-30 h-16 flex items-center justify-between px-4 lg:px-6 border-b transition-colors duration-300 ${
        isDark ? "bg-gray-900/80 backdrop-blur-md border-gray-800" : "bg-white/80 backdrop-blur-md border-gray-200"
      }`}> 
        
        <div className="flex items-center gap-3"> 
          <button onClick={onMenuClick} className={`lg:hidden p-2 rounded-lg transition-colors ${isDark ? "hover:bg-gray-800 text-gray-400 hover:text-white" : "hover:bg-gray-100 text-gray-600 hover:text-gray-900"}`}> 
            <Menu size={22} /> 
          </button> 
          <h1 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{title}</h1> 
        </div> 

        <div className="flex items-center gap-2"> 
          
          {/* THEME TOGGLE */}
          <button onClick={toggleTheme} className={`relative w-14 h-7 rounded-full p-1 transition-colors duration-300 focus:outline-none ${isDark ? "bg-gray-600" : "bg-gray-300"}`}>
            <div className={`w-5 h-5 rounded-full bg-white shadow-md transform transition-transform duration-300 flex items-center justify-center ${isDark ? "translate-x-7" : "translate-x-0"}`}>
              {isDark ? <Moon size={12} className="text-indigo-600" /> : <Sun size={12} className="text-amber-500" />}
            </div>
          </button>

          {/* PREMIUM AI BUTTON */}
          <button 
            onClick={() => setIsChatOpen(true)} 
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              isDark 
                ? "bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 border border-indigo-500/30" 
                : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border border-indigo-200"
            }`}
            title="Ask AI Assistant"
          > 
            <Sparkles size={16} className="text-indigo-500" /> 
            <span className="hidden sm:inline">AI</span>
          </button>

          {/* NOTIFICATIONS BELL */} 
          <div className="relative"> 
            <button onClick={() => setShowDropdown(!showDropdown)} className={`relative p-2 rounded-lg transition-colors ${isDark ? "hover:bg-gray-800 text-gray-400 hover:text-white" : "hover:bg-gray-100 text-gray-600 hover:text-gray-900"}`}> 
              <Bell size={20} /> 
              {unreadCount > 0 && ( 
                <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"> 
                  {unreadCount > 9 ? "9+" : unreadCount} 
                </span> 
              )} 
            </button> 

            {showDropdown && ( 
              <> 
                <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} /> 
                <div className={`absolute right-0 mt-2 w-80 border rounded-xl shadow-2xl z-50 overflow-hidden ${isDark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"}`}> 
                  <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? "border-gray-700" : "border-gray-200"}`}> 
                    <h3 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-800"}`}>Notifications</h3> 
                    {unreadCount > 0 && ( <button onClick={markAllAsRead} className="text-xs text-blue-500 hover:text-blue-400 font-medium">Mark all as read</button> )} 
                  </div> 
                  <div className="max-h-80 overflow-y-auto"> 
                    {notifications.length === 0 ? ( 
                      <div className={`px-4 py-8 text-center text-sm ${isDark ? "text-gray-500" : "text-gray-400"}`}>No notifications yet</div> 
                    ) : ( 
                      notifications.map(n => ( 
                        <div key={n.id} onClick={() => { if (!n.is_read) markAsRead(n.id); const titleLower = n.title.toLowerCase(); if (titleLower.includes("project")) router.push("/dashboard/projects"); else if (titleLower.includes("income")) router.push("/dashboard/income"); else if (titleLower.includes("expense")) router.push("/dashboard/expenses"); else if (titleLower.includes("invoice")) router.push("/dashboard/invoices"); setShowDropdown(false); }} className={`flex items-start gap-3 px-4 py-3 border-b transition-colors cursor-pointer ${isDark ? "border-gray-700/50 hover:bg-gray-700/50" : "border-gray-100 hover:bg-gray-50"} ${!n.is_read ? (isDark ? "bg-blue-500/5" : "bg-blue-50") : ""}`}> 
                          <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${n.is_read ? "bg-transparent" : "bg-blue-500"}`} /> 
                          <div className="flex-1 min-w-0"> 
                            <p className={`text-sm ${n.is_read ? (isDark ? "text-gray-400" : "text-gray-500") : (isDark ? "text-white font-medium" : "text-gray-900 font-medium")}`}>{n.title}</p>
                            <span className={`text-[10px] ${isDark ? "text-gray-500" : "text-gray-400"}`}>{timeAgo(n.created_at)}</span>
                          </div> 
                        </div> 
                      ))
                    )} 
                  </div> 
                </div> 
              </> 
            )} 
          </div>
        </div> 
      </header> 

      <AiChatSlideOver isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} />
    </> 
  ); 
}
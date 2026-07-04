'use client' ; 
import { useState, useEffect } from 'react' ; 
import { Menu, Bell, Search, Check } from 'lucide-react' ; 
import { useAuth } from '@/context/AuthContext' ; 
import { supabase } from '@/lib/supabase' ; 
import type { Notification } from '@/types' ; 
import { useRouter } from "next/navigation";

interface TopNavbarProps { 
  onMenuClick: () => void; 
  title: string; 
} 

export default function TopNavbar({ onMenuClick, title }: TopNavbarProps) { 
  const { user } = useAuth(); 
  const router = useRouter(); // YEH ADD KIYA
  
  // Safe extraction for fallback values
  const initials = user && user.email ? user.email[0].toUpperCase() : 'U'; 

  // Notification States 
  const [notifications, setNotifications] = useState<Notification[]>([]); 
  const [showDropdown, setShowDropdown] = useState(false); 
  const [unreadCount, setUnreadCount] = useState(0); 

  // Fetch Notifications 
    // Fetch Notifications (Safe)
  useEffect(() => {
    if (!user) return;
    const userId = user.id;

    async function fetchNotifications() {
      try {
        const { data, error } = await supabase
          .from("notifications")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(10);

        if (error) {
          console.error("Notifications fetch error:", error.message);
          return; // Error aaye toh app crash nahi hoga
        }

        if (data) {
          setNotifications(data);
          setUnreadCount(data.filter(n => !n.is_read).length);
        }
      } catch (err) {
        console.error("Notifications unexpected error:", err);
      }
    }
    fetchNotifications();
  }, [user]);
  // Mark as Read 
  async function markAsRead(notifId: string) { 
    await supabase.from('notifications').update({ is_read: true }).eq('id', notifId); 
    setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, is_read: true } : n)); 
    setUnreadCount(prev => prev - 1); 
  } 

  // Mark All as Read 
  async function markAllAsRead() { 
    // 2. FIXED: Explicit guard clause for the action block
    if (!user || !user.id) return; 
    
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', user.id) // Guarded directly above
      .eq('is_read', false); 
      
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true }))); 
    setUnreadCount(0); 
  } 

  // Time Ago Function 
  function timeAgo(dateStr: string) { 
    const now = new Date(); 
    const date = new Date(dateStr); 
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000); 

    if (seconds < 60) return 'Just now'; 
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; 
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; 
    return `${Math.floor(seconds / 86400)}d ago`; 
  } 

  return ( 
    <header className="sticky top-0 z-30 h-16 bg-gray-900/80 backdrop-blur-md border-b border-gray-800 flex items-center justify-between px-4 lg:px-6"> 
      {/* Left */} 
      <div className="flex items-center gap-3"> 
        <button onClick={onMenuClick} className="lg:hidden p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"> 
          <Menu size={22} /> 
        </button> 
        <h1 className="text-lg font-semibold text-white">{title}</h1> 
      </div> 

      {/* Right */} 
      <div className="flex items-center gap-2"> 
        {/* Search (Desktop) */} 
        <button className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 text-sm hover:border-gray-600 transition-colors"> 
          <Search className="w-4 h-4" /> 
          <span>Search...</span> 
          <kbd className="ml-4 text-[10px] font-mono bg-gray-900 px-1.5 py-0.5 rounded text-gray-500">Ctrl+K</kbd> 
        </button> 

        {/* Notifications Bell */} 
        <div className="relative"> 
          <button onClick={() => setShowDropdown(!showDropdown)} className="relative p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"> 
            <Bell size={20} /> 
            {unreadCount > 0 && ( 
              <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center"> 
                {unreadCount > 9 ? '9+' : unreadCount} 
              </span> 
            )} 
          </button> 

          {/* Dropdown */} 
          {showDropdown && ( 
            <> 
              <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} /> 
              <div className="absolute right-0 mt-2 w-80 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden animate-[slideUp_0.2s_ease-out]"> 
                {/* Header */} 
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700"> 
                  <h3 className="text-sm font-semibold text-white">Notifications</h3> 
                  {unreadCount > 0 && ( 
                    <button onClick={markAllAsRead} className="text-xs text-blue-400 hover:text-blue-300 font-medium"> 
                      Mark all as read 
                    </button> 
                  )} 
                </div> 

                {/* List */} 
                <div className="max-h-80 overflow-y-auto"> 
                  {notifications.length === 0 ? ( 
                    <div className="px-4 py-8 text-center text-gray-500 text-sm">No notifications yet</div> 
                  ) : ( 
                    notifications.map(n => ( 
                                            <div 
                        key={n.id} 
                                                onClick={() => {
                          if (!n.is_read) markAsRead(n.id);
                          
                          // Title se smartly route karo
                          const titleLower = n.title.toLowerCase();
                          if (titleLower.includes("project")) router.push("/dashboard/projects");
                          else if (titleLower.includes("income")) router.push("/dashboard/income");
                          else if (titleLower.includes("expense")) router.push("/dashboard/expenses");
                          else if (titleLower.includes("invoice")) router.push("/dashboard/invoices");
                          
                          setShowDropdown(false);
                        }}
                        className={`flex items-start gap-3 px-4 py-3 border-b border-gray-700/50 hover:bg-gray-700/50 transition-colors cursor-pointer ${!n.is_read ? 'bg-blue-500/5' : ''}`} 
                      >
                        <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${n.is_read ? 'bg-transparent' : 'bg-blue-500'}`} /> 
                        <div className="flex-1 min-w-0"> 
                          <p className={`text-sm ${n.is_read ? 'text-gray-400' : 'text-white font-medium'}`}>{n.title}</p> 
                          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{n.message}</p> 
                          <p className="text-[10px] text-gray-600 mt-1">{timeAgo(n.created_at)}</p> 
                        </div> 
                      </div> 
                    )) 
                  )} 
                </div> 
              </div> 
            </> 
          )} 
        </div> 

        {/* Avatar */} 
        <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold cursor-pointer"> 
          {initials} 
        </div> 
      </div> 
    </header> 
  ); 
}

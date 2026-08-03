'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { UserProfile } from '@/types';
import type { User } from '@supabase/supabase-js';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  role: string;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  hasPermission: (permission: keyof UserProfile) => boolean;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // CRITICAL: loading stays TRUE until BOTH session AND profile are loaded
  const [loading, setLoading] = useState(true);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Fetch profile whenever user changes
  const fetchProfile = useCallback(async (authUser: User | null) => {
    if (!authUser) {
      setProfile(null);
      return;
    }

    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", authUser.id)
        .maybeSingle();

      if (error) {
        console.error("Profile fetch error:", error.message);
        // Set a default profile with 'User' role on error
        setProfile({
          id: "",
          user_id: authUser.id,
          full_name: "",
          role: "User",
          created_at: "",
          email: authUser.email || "",
          can_create_project: false,
          can_edit_project: false,
          can_delete_project: false,
          can_add_income: false,
          can_edit_income: false,
          can_delete_income: false,
          can_add_expense: false,
          can_edit_expense: false,
          can_delete_expense: false,
          can_create_invoice: false,
          can_edit_invoice: false,
          can_delete_invoice: false,
        });
      } else if (data) {
        const profileData: UserProfile = {
          id: data.id || "",
          user_id: data.user_id || authUser.id,
          full_name: data.full_name || "",
          role: data.role || "User",
          created_at: data.created_at || "",
          email: data.email || authUser.email || "",
          can_create_project: Boolean(data.can_create_project),
          can_edit_project: Boolean(data.can_edit_project),
          can_delete_project: Boolean(data.can_delete_project),
          can_add_income: Boolean(data.can_add_income),
          can_edit_income: Boolean(data.can_edit_income),
          can_delete_income: Boolean(data.can_delete_income),
          can_add_expense: Boolean(data.can_add_expense),
          can_edit_expense: Boolean(data.can_edit_expense),
          can_delete_expense: Boolean(data.can_delete_expense),
          can_create_invoice: Boolean(data.can_create_invoice),
          can_edit_invoice: Boolean(data.can_edit_invoice),
          can_delete_invoice: Boolean(data.can_delete_invoice),
        };
        console.log("Profile Loaded Successfully. Role:", profileData.role);
        setProfile(profileData);
      } else {
        // No profile found — set default profile
        console.warn("No profile found for user:", authUser.email, "— using default profile");
        setProfile({
          id: "",
          user_id: authUser.id,
          full_name: "",
          role: "Viewer",
          created_at: "",
          email: authUser.email || "",
          can_create_project: false,
          can_edit_project: false,
          can_delete_project: false,
          can_add_income: false,
          can_edit_income: false,
          can_delete_income: false,
          can_add_expense: false,
          can_edit_expense: false,
          can_delete_expense: false,
          can_create_invoice: false,
          can_edit_invoice: false,
          can_delete_invoice: false,
        });
      }
    } catch (err) {
      console.error("Profile exception:", err);
    } finally {
      // Profile fetch complete — now safe to set loading = false
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session?.user) {
        setUser(data.session.user);
        // Fetch profile BEFORE setting loading = false
        fetchProfile(data.session.user);
      } else {
        setUser(null);
        setProfile(null);
        setLoading(false); // No session = no loading
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const authUser = session?.user ?? null;
      setUser(authUser);
      if (!authUser) {
        setProfile(null);
        setLoading(false);
      } else {
        // Fetch profile for the new session, keep loading true until done
        setLoading(true);
        await fetchProfile(authUser);
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  const role = profile?.role || 'User';
  // Support both legacy 'Admin' and new 'CEO' as admin
  const isAdmin = role === 'Admin' || role === 'CEO';

  const hasPermission = (permission: keyof UserProfile): boolean => {
    if (!profile) return false;
    if (isAdmin) return true;
    return Boolean(profile[permission]);
  };

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return error?.message || null;
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error?.message || null;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ 
      user, profile, role, loading, signUp, signIn, signOut, hasPermission, isAdmin 
    }}>
      {children}
    </AuthContext.Provider>
  );
}

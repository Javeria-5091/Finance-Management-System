"use client";
import { useState, FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "next/navigation";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Link from "next/link";

export default function LoginPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    
    const errMsg = await signIn(email, password);
    setLoading(false);

    if (errMsg) {
      setError(errMsg);
    } else {
      router.push("/dashboard");
    }
  }

  return (
    // FIXED: Main background shifts cleanly from light gray to dark slate
    <main className="min-h-screen flex items-center justify-center px-4 bg-gray-50 dark:bg-gray-900 transition-colors duration-200">
      {/* FIXED: Card layout changes from clean white to graphite block based on state */}
      <div className="w-full max-w-md bg-white dark:bg-gray-800 p-8 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm dark:shadow-xl transition-colors duration-200">
        
        {/* FIXED: Text color adjusts from bold slate to bright white */}
        <h1 className="text-2xl font-bold text-center mb-6 text-gray-900 dark:text-white">
          Welcome Back
        </h1>
        
        {/* FIXED: Improved color rendering for light vs dark mode alert boxes */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/20 border border-red-200 dark:border-red-500/50 text-red-600 dark:text-red-300 rounded-lg text-sm font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input 
            id="email" 
            label="Email" 
            type="email" 
            placeholder="you@example.com" 
            value={email} 
            onChange={e => setEmail(e.target.value)} 
            required 
          />
          <Input 
            id="password" 
            label="Password" 
            type="password" 
            placeholder="••••••••" 
            value={password} 
            onChange={e => setPassword(e.target.value)} 
            required 
          />
          <Button type="submit" loading={loading}>Sign In</Button>
        </form>

        {/* FIXED: Contrast optimization for context links */}
        <p className="text-center text-sm text-gray-600 dark:text-gray-400 mt-6">
          Don't have an account?{" "}
          <Link href="/signup" className="text-blue-600 dark:text-blue-400 hover:underline font-medium">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}

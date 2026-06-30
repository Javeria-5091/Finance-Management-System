export interface Income {
  id: string;
  user_id: string;
  title: string;
  amount: number;
  category: string;
  description: string | null;
  income_date: string;
  created_at: string;
}

export type IncomeFormData = Omit<Income, "id" | "user_id" | "created_at">;

export const CATEGORIES = ["Salary", "Freelance", "Business", "Investment", "Other"];
export default function BankingLayout({ children }: { children: React.ReactNode }) {
  //  Simple layout — main dashboard sidebar already handles navigation
  return <div className="p-6">{children}</div>;
}


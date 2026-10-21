import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ALEXIOS // Interface de Comando",
  description: "Painel de comando e monitoramento remoto do Alexios Core.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}

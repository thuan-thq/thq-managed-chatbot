import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chat Widget",
  description: "Embeddable RAG chatbot widget",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ErrorProvider } from "../components/ErrorProvider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Anime",
  description: "AI-powered anime animation studio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ErrorProvider>{children}</ErrorProvider>
      </body>
    </html>
  );
}

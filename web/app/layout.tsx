import type { Metadata } from "next";
import { Playfair_Display, Sora } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-playfair",
});

const sora = Sora({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sora",
});

export const metadata: Metadata = {
  title: "Raphael",
  description: "Raphael chat — walking skeleton",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${playfair.variable} ${sora.variable} dark`}>
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

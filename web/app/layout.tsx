import type { Metadata, Viewport } from "next";
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

// Without this a phone renders the page at ~980px and scales it down, so every
// layout reads as a tiny desktop no matter what the CSS says. width=device-width
// is the switch that makes responsive styling apply at all.
// maximumScale/userScalable are deliberately NOT restricted: blocking pinch-zoom
// is an accessibility failure, and the layout should survive the user zooming.
// viewportFit=cover + the safe-area padding in globals.css keeps the UI clear of
// the notch and the home indicator on iOS.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#04070d",
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

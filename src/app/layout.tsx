import "./globals.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const inter = Inter({
	subsets: ["latin"],
	variable: "--font-sans",
});

export const metadata: Metadata = {
	metadataBase: new URL("https://shtora.cloud"),
	title: "Shtora Cloud | Modelos de IA grátis de vários provedores",
	description:
		"Reúna modelos gratuitos de vários provedores de IA em um só lugar: APIs compatíveis com OpenAI e Anthropic, failover automático entre provedores e provedores sem chave.",
	alternates: { canonical: "/" },
	icons: { icon: "/favicon.svg" },
	openGraph: {
		url: "https://shtora.cloud",
		siteName: "Shtora Cloud",
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" className={cn("dark font-sans", inter.variable)}>
			<body>
				<TooltipProvider>
					{children}
					<Toaster />
				</TooltipProvider>
			</body>
		</html>
	);
}

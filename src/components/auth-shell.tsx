import Link from "next/link";
import type { ReactNode } from "react";
import { AuthBackground } from "@/components/auth-background";
import { Logo } from "@/components/logo";

interface AuthShellProps {
	title: string;
	subtitle: string;
	children: ReactNode;
	footer: ReactNode;
}

export function AuthShell({
	title,
	subtitle,
	children,
	footer,
}: AuthShellProps) {
	return (
		<div className="min-h-dvh bg-background text-foreground md:grid md:grid-cols-2">
			<div className="relative hidden overflow-hidden md:block">
				<AuthBackground />
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/70 to-transparent" />
				<Link
					href="/"
					className="absolute left-10 top-10 z-10 flex items-center gap-2.5 text-[22px] font-semibold tracking-tight"
					aria-label="Shtora Cloud, início"
				>
					<Logo decorative className="size-8" />
					<span>shtora</span>
				</Link>
				<div className="absolute bottom-10 left-10 z-10">
					<p className="font-mono text-[10px] tracking-[2px] text-primary/60">
						SHTORA
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Um token. Vários provedores.
					</p>
				</div>
			</div>

			<main className="flex min-h-dvh items-center justify-center border-l border-border px-6 py-14 md:min-h-0">
				<div className="w-full max-w-sm">
					<div className="mb-8">
						<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
						<p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
					</div>
					{children}
					<div className="mt-5 text-left text-sm text-muted-foreground">
						{footer}
					</div>
				</div>
			</main>
		</div>
	);
}

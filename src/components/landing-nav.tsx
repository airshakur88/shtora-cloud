"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { SessionUser } from "@/lib/server-session";

interface LandingNavProps {
	user: SessionUser | null;
}

const LINK =
	"inline-flex items-center gap-4 text-sm hover:text-[#e3ab88] focus-visible:outline-2 focus-visible:outline-[#e3ab88] focus-visible:outline-offset-[5px]";

export function LandingNav({ user }: LandingNavProps) {
	if (user) {
		return (
			<Link href="/dashboard" className={LINK}>
				{user.username} <ArrowUpRight size={15} aria-hidden="true" />
			</Link>
		);
	}
	return (
		<Link href="/login" className={LINK}>
			Entrar <ArrowUpRight size={15} aria-hidden="true" />
		</Link>
	);
}

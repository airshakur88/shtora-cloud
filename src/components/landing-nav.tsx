"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { SessionUser } from "@/lib/server-session";

interface LandingNavProps {
	user: SessionUser | null;
}

export function LandingNav({ user }: LandingNavProps) {
	if (user) {
		return (
			<Link href="/dashboard" className="landing-login">
				{user.username} <ArrowUpRight size={15} aria-hidden="true" />
			</Link>
		);
	}
	return (
		<Link href="/login" className="landing-login">
			Entrar <ArrowUpRight size={15} aria-hidden="true" />
		</Link>
	);
}

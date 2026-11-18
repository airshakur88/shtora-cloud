"use client";

import { ReactionFront } from "@/components/ui/hero-ascii-reaction-front";

export function AuthBackground() {
	return (
		<div
			className="absolute inset-0 text-primary opacity-15"
			aria-hidden="true"
		>
			<ReactionFront cellSize={11} />
		</div>
	);
}

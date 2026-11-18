"use client";

import { ReactionFront } from "@/components/ui/hero-ascii-reaction-front";

export function HeroBackground() {
	return (
		<div
			className="pointer-events-none absolute inset-0 z-0 text-[#e3ab88] opacity-[0.18]"
			aria-hidden="true"
		>
			<ReactionFront cellSize={12} />
		</div>
	);
}

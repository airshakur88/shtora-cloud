"use client";

import { ReactionFront } from "@/components/ui/hero-ascii-reaction-front";

export function HeroBackground() {
	return (
		<div className="hero-ascii-bg" aria-hidden="true">
			<ReactionFront cellSize={12} />
		</div>
	);
}

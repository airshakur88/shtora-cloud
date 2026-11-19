import { useId } from "react";

interface LogoProps {
	/** Extra classes, e.g. a size. Defaults to size-8. */
	className?: string;
	/**
	 * Hide the logo from assistive tech. Use it when the logo sits inside
	 * a link that already has an accessible name.
	 */
	decorative?: boolean;
}

/**
 * The Shtora "S." monogram: dark tile, copper frame, copper S and period.
 * Ids are suffixed per instance so several logos on one page never share
 * an id (the title is referenced by aria-labelledby).
 */
export function Logo({ className, decorative = false }: LogoProps) {
	const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
	const titleId = `logo-title-${uid}`;
	const backgroundId = `logo-background-${uid}`;
	const frameId = `logo-frame-${uid}`;
	const monogramId = `logo-monogram-${uid}`;
	const letterId = `logo-letter-s-${uid}`;
	const periodId = `logo-period-${uid}`;
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 200 200"
			role="img"
			aria-labelledby={decorative ? undefined : titleId}
			aria-hidden={decorative || undefined}
			className={className ?? "size-8"}
		>
			<title id={titleId}>S.</title>
			<rect
				id={backgroundId}
				x="20.5"
				y="19.5"
				width="155"
				height="165"
				fill="#0C0D0F"
			/>
			<rect
				id={frameId}
				x="20.5"
				y="19.5"
				width="155"
				height="165"
				fill="none"
				stroke="#675243"
				strokeWidth="5"
			/>
			<g id={monogramId} fill="#E3AB88">
				<path
					id={letterId}
					d="M 88,81 C 103,81 114,85 114,94.5 C 114,100.2 109.7,104 103.2,104 C 94.7,104 91.3,97.6 88.2,85.8 C 80.8,86.7 75.8,90.9 75.8,97.1 C 75.8,102.8 79.8,104.9 88.4,108 C 100.8,112.4 109.1,117.5 109.1,128.1 C 109.1,143.8 94.4,152.1 73.5,152.1 C 56.9,152.1 44.3,147.4 44.3,137.7 C 44.3,131.6 49.1,127.6 55.3,127.6 C 64,127.6 68.4,135.2 71.8,146.9 C 80.9,147.1 86.9,142.7 86.9,135.2 C 86.9,129.4 82.8,127.1 74.1,124.1 C 61.8,119.8 53.4,114.6 53.4,102.9 C 53.4,89.3 68.6,81 88,81 Z"
				/>
				<ellipse id={periodId} cx="132.25" cy="138.55" rx="13.7" ry="13.6" />
			</g>
		</svg>
	);
}

"use client";

import { type RefObject, useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";

export interface AnimatedBeamProps {
	className?: string;
	containerRef: RefObject<HTMLElement | null>; // Container ref
	fromRef: RefObject<HTMLElement | null>;
	toRef: RefObject<HTMLElement | null>;
	orientation?: "horizontal" | "vertical";
	curvature?: number;
	reverse?: boolean;
	pathColor?: string;
	pathWidth?: number;
	pathOpacity?: number;
	gradientStartColor?: string;
	gradientStopColor?: string;
	delay?: number;
	duration?: number;
	repeat?: number;
	repeatDelay?: number;
	startXOffset?: number;
	startYOffset?: number;
	endXOffset?: number;
	endYOffset?: number;
}

export const AnimatedBeam: React.FC<AnimatedBeamProps> = ({
	className,
	containerRef,
	fromRef,
	toRef,
	orientation = "horizontal",
	curvature = 0,
	reverse = false, // Include the reverse prop
	duration = 5,
	delay = 0,
	pathColor = "gray",
	pathWidth = 2,
	pathOpacity = 0.2,
	gradientStartColor = "#ffaa40",
	gradientStopColor = "#9c40ff",
	repeat = Infinity,
	repeatDelay = 0,
	startXOffset = 0,
	startYOffset = 0,
	endXOffset = 0,
	endYOffset = 0,
}) => {
	const id = useId();
	const [pathD, setPathD] = useState("");
	const [spanY, setSpanY] = useState({ start: 0, end: 0 });
	const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });

	const gradientCoordinates =
		orientation === "vertical"
			? {
					x1: ["0%", "0%"],
					x2: ["0%", "0%"],
					y1: reverse
						? [spanY.end + 70, spanY.start - 10]
						: [spanY.start - 10, spanY.end + 70],
					y2: reverse
						? [spanY.end + 10, spanY.start - 70]
						: [spanY.start - 70, spanY.end + 10],
				}
			: reverse
				? {
						x1: ["90%", "-10%"],
						x2: ["100%", "0%"],
						y1: ["0%", "0%"],
						y2: ["0%", "0%"],
					}
				: {
						x1: ["10%", "110%"],
						x2: ["0%", "100%"],
						y1: ["0%", "0%"],
						y2: ["0%", "0%"],
					};

	useEffect(() => {
		const updatePath = () => {
			if (containerRef.current && fromRef.current && toRef.current) {
				const containerRect = containerRef.current.getBoundingClientRect();
				const rectA = fromRef.current.getBoundingClientRect();
				const rectB = toRef.current.getBoundingClientRect();

				const svgWidth = containerRect.width;
				const svgHeight = containerRect.height;
				setSvgDimensions({ width: svgWidth, height: svgHeight });

				if (orientation === "vertical") {
					const startX =
						rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
					const startY =
						rectA.top - containerRect.top + rectA.height + startYOffset;
					const endX =
						rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
					const endY = rectB.top - containerRect.top + endYOffset;
					const midY = (startY + endY) / 2;
					setSpanY({ start: startY, end: endY });
					setPathD(
						`M ${startX},${startY} C ${startX},${midY} ${endX},${midY} ${endX},${endY}`,
					);
					return;
				}

				const startX =
					rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
				const startY =
					rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
				const endX =
					rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
				const endY =
					rectB.top - containerRect.top + rectB.height / 2 + endYOffset;

				const controlY = startY - curvature;
				const d = `M ${startX},${startY} Q ${
					(startX + endX) / 2
				},${controlY} ${endX},${endY}`;
				setPathD(d);
			}
		};

		// Initialize ResizeObserver
		const resizeObserver = new ResizeObserver(() => {
			updatePath();
		});

		// Observe the container element
		if (containerRef.current) {
			resizeObserver.observe(containerRef.current);
		}

		// Call the updatePath initially to set the initial path
		updatePath();

		// Clean up the observer on component unmount
		return () => {
			resizeObserver.disconnect();
		};
	}, [
		containerRef,
		fromRef,
		toRef,
		orientation,
		curvature,
		startXOffset,
		startYOffset,
		endXOffset,
		endYOffset,
	]);

	return (
		<svg
			aria-hidden="true"
			fill="none"
			width={svgDimensions.width}
			height={svgDimensions.height}
			xmlns="http://www.w3.org/2000/svg"
			className={cn(
				"pointer-events-none absolute top-0 left-0 transform-gpu stroke-2",
				className,
			)}
			viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
		>
			<path
				d={pathD}
				stroke={pathColor}
				strokeWidth={pathWidth}
				strokeOpacity={pathOpacity}
				strokeLinecap="round"
			/>
			<path
				d={pathD}
				strokeWidth={pathWidth}
				stroke={`url(#${id})`}
				strokeOpacity="1"
				strokeLinecap="round"
			/>
			<defs>
				{/*
				 * The gradient sweep, as native SMIL: each coordinate
				 * travels from its start value to its end value on the
				 * easeOutExpo curve (0.16 1 0.3 1), then restarts — the
				 * same loop motion/react used to run. SMIL replaces the
				 * animation library here: motion was the only reason
				 * the landing's first paint pulled it in (B9), and the
				 * beam is decorative, so no JS animation runtime is
				 * needed for it. A nonzero repeatDelay becomes a hold
				 * at the end values before the next loop.
				 */}
				<linearGradient
					className="transform-gpu"
					id={id}
					gradientUnits={"userSpaceOnUse"}
					x1={gradientCoordinates.x1[0]}
					x2={gradientCoordinates.x2[0]}
					y1={gradientCoordinates.y1[0]}
					y2={gradientCoordinates.y2[0]}
				>
					{(["x1", "x2", "y1", "y2"] as const).map((name) => {
						const [from, to] = gradientCoordinates[name];
						const totalDuration = duration + repeatDelay;
						const sweepEnd = repeatDelay > 0 ? duration / totalDuration : 1;
						return (
							<animate
								key={name}
								attributeName={name}
								values={
									repeatDelay > 0 ? `${from};${to};${to}` : `${from};${to}`
								}
								keyTimes={repeatDelay > 0 ? `0;${sweepEnd};1` : "0;1"}
								keySplines={
									repeatDelay > 0 ? "0.16 1 0.3 1;0.16 1 0.3 1" : "0.16 1 0.3 1"
								}
								calcMode="spline"
								dur={`${totalDuration}s`}
								begin={`${delay}s`}
								repeatCount={
									repeat === Infinity ? "indefinite" : String(repeat)
								}
							/>
						);
					})}
					<stop stopColor={gradientStartColor} stopOpacity="0"></stop>
					<stop stopColor={gradientStartColor}></stop>
					<stop offset="32.5%" stopColor={gradientStopColor}></stop>
					<stop
						offset="100%"
						stopColor={gradientStopColor}
						stopOpacity="0"
					></stop>
				</linearGradient>
			</defs>
		</svg>
	);
};

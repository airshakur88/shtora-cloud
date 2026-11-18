"use client";

import {
	type ReactNode,
	type TransitionEvent as ReactTransitionEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { cn } from "@/lib/utils";

const OPEN_MS = 260;
const CLOSE_MS = 200;
const EASE = "cubic-bezier(0.22,1,0.36,1)";

export interface FaqDepthItem {
	id: string;
	question: string;
	answer: ReactNode;
}

export interface FaqDepthGutterProps {
	/** the question/answer pairs, in order */
	items: FaqDepthItem[];
	/** Allow more than one answer open at once. Default false (single-open). */
	allowMultiple?: boolean;
	/** Item ids open on first render. */
	defaultOpen?: string[];
	/** extra classes merged onto the rendered root element */
	className?: string;
}

function prefersReduced() {
	return (
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function FaqDepthGutter({
	items,
	allowMultiple = false,
	defaultOpen = [],
	className = "",
}: FaqDepthGutterProps) {
	const baseId = useId().replace(/:/g, "");
	const [openIds, setOpenIds] = useState<Set<string>>(
		() => new Set(defaultOpen),
	);

	const panelRefs = useRef<Map<string, HTMLElement>>(new Map());
	const initialized = useRef<Set<string>>(new Set());
	const prevOpen = useRef<Set<string>>(new Set(defaultOpen));
	const openRef = useRef(openIds);

	openRef.current = openIds;

	const expand = useCallback((id: string) => {
		const el = panelRefs.current.get(id);
		if (!el) return;
		el.hidden = false;
		el.style.transition = "none";
		el.style.height = "0px";
		void el.offsetHeight; // forced reflow: commit the start height
		if (prefersReduced()) {
			el.style.transition = "";
			el.style.height = "auto";
			return;
		}
		el.style.transition = `height ${OPEN_MS}ms ${EASE}`;
		el.style.height = `${el.scrollHeight}px`;
	}, []);

	const collapse = useCallback((id: string) => {
		const el = panelRefs.current.get(id);
		if (!el) return;
		el.style.transition = "none";
		el.style.height = `${el.offsetHeight}px`; // pin height:auto back to px
		void el.offsetHeight; // forced reflow before easing down
		if (prefersReduced()) {
			el.style.transition = "";
			el.style.height = "0px";
			el.hidden = true;
			return;
		}
		el.style.transition = `height ${CLOSE_MS}ms ${EASE}`;
		el.style.height = "0px";
	}, []);

	useEffect(() => {
		openIds.forEach((id) => {
			if (!prevOpen.current.has(id)) expand(id);
		});
		prevOpen.current.forEach((id) => {
			if (!openIds.has(id)) collapse(id);
		});
		prevOpen.current = new Set(openIds);
	}, [openIds, expand, collapse]);

	const onPanelTransitionEnd = (
		e: ReactTransitionEvent<HTMLElement>,
		id: string,
	) => {
		if (e.propertyName !== "height" || e.target !== e.currentTarget) return;
		const el = panelRefs.current.get(id);
		if (!el) return;
		el.style.transition = "";
		if (openRef.current.has(id)) {
			// auto, not px: later reflow or a text-wrap change stays correct
			el.style.height = "auto";
		} else {
			el.style.height = "0px";
			el.hidden = true;
		}
	};

	const toggle = (id: string) => {
		setOpenIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				if (!allowMultiple) next.clear();
				next.add(id);
			}
			return next;
		});
	};

	return (
		<div className={cn("w-full pl-[14px] text-[#eeeae5]", className)}>
			{items.map((item, index) => {
				const isOpen = openIds.has(item.id);
				const triggerId = `${baseId}-q-${item.id}`;
				const panelId = `${baseId}-a-${item.id}`;

				return (
					<div
						key={item.id}
						className={cn(
							"relative before:absolute before:-left-[14px] before:top-[26px] before:h-[18px] before:w-[2px] before:rounded-full before:bg-transparent before:transition-[background-color_160ms_ease]",
							index > 0 && "border-t border-[#2a2b2e]",
							isOpen && "before:bg-[#e3ab88]",
						)}
						data-open={isOpen}
					>
						<h3 className="m-0 text-[inherit] font-[inherit]">
							<button
								type="button"
								id={triggerId}
								data-faq-trigger=""
								className="group flex w-full cursor-pointer items-center justify-between gap-5 rounded-md border-0 bg-transparent py-[22px] text-left text-base leading-[1.4] text-[#eeeae5] focus-visible:outline-2 focus-visible:outline-[#e3ab88] focus-visible:outline-offset-[3px]"
								aria-expanded={isOpen}
								aria-controls={panelId}
								onClick={() => toggle(item.id)}
							>
								<span className="min-w-0 transition-colors duration-160 group-hover:text-[#e3ab88] motion-reduce:transition-none">
									{item.question}
								</span>
								<span
									className="relative size-[10px] shrink-0"
									data-open={isOpen}
									aria-hidden="true"
								>
									<span className="absolute top-[4.25px] left-0 h-[1.5px] w-[10px] bg-[#aaa6a1]" />
									<span
										className={cn(
											"absolute top-0 left-[4.25px] h-[10px] w-[1.5px] origin-center bg-[#aaa6a1] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
											isOpen && "scale-y-0",
										)}
									/>
								</span>
							</button>
						</h3>

						<section
							id={panelId}
							ref={(el) => {
								if (!el) {
									panelRefs.current.delete(item.id);
									return;
								}
								panelRefs.current.set(item.id, el);
								if (initialized.current.has(item.id)) return;
								initialized.current.add(item.id);
								if (openIds.has(item.id)) {
									el.style.height = "auto";
								} else {
									el.style.height = "0px";
									el.hidden = true;
								}
							}}
							data-faq-panel=""
							data-open={isOpen}
							aria-labelledby={triggerId}
							className="h-0 overflow-hidden"
							onTransitionEnd={(e) => onPanelTransitionEnd(e, item.id)}
						>
							<div className="pb-5 text-[14.5px] leading-[1.8] text-[#aaa6a1] [&_p]:m-0 [&_p+p]:mt-[11px]">
								{item.answer}
							</div>
						</section>
					</div>
				);
			})}
		</div>
	);
}

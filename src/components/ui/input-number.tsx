"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface InputNumberProps
	extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
	value?: string | number;
	onValueChange?: (value: string | undefined) => void;
	minValue?: number;
	maxValue?: number;
	step?: number;
}

function InputNumber({
	className,
	value,
	onValueChange,
	minValue,
	maxValue,
	step = 1,
	placeholder,
	disabled,
	...props
}: InputNumberProps) {
	const inputRef = React.useRef<HTMLInputElement>(null);

	const numericValue = React.useMemo(() => {
		if (value === undefined || value === "") return undefined;
		const num = typeof value === "string" ? parseFloat(value) : value;
		return Number.isNaN(num) ? undefined : num;
	}, [value]);

	const clampValue = React.useCallback(
		(val: number) => {
			let clamped = val;
			if (minValue !== undefined) clamped = Math.max(minValue, clamped);
			if (maxValue !== undefined) clamped = Math.min(maxValue, clamped);
			return clamped;
		},
		[minValue, maxValue],
	);

	const handleIncrement = React.useCallback(() => {
		const current = numericValue ?? minValue ?? 0;
		const next = clampValue(current + step);
		onValueChange?.(String(next));
	}, [numericValue, minValue, step, clampValue, onValueChange]);

	const handleDecrement = React.useCallback(() => {
		const current = numericValue ?? minValue ?? 0;
		const next = clampValue(current - step);
		onValueChange?.(String(next));
	}, [numericValue, minValue, step, clampValue, onValueChange]);

	const handleInputChange = React.useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const raw = e.target.value;
			if (raw === "" || raw === "-") {
				onValueChange?.(undefined);
				return;
			}
			const num = parseFloat(raw);
			if (Number.isNaN(num)) return;
			onValueChange?.(raw);
		},
		[onValueChange],
	);

	const handleKeyDown = React.useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				handleIncrement();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				handleDecrement();
			}
		},
		[handleIncrement, handleDecrement],
	);

	const canDecrement =
		!disabled && (numericValue === undefined || numericValue > (minValue ?? -Infinity));
	const canIncrement =
		!disabled && (numericValue === undefined || numericValue < (maxValue ?? Infinity));

	return (
		<div
			data-slot="input-number"
			className={cn(
				"flex h-9 w-full items-center rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 has-[:invalid]:border-destructive has-[:invalid]:ring-destructive/20",
				className,
			)}
		>
			<input
				ref={inputRef}
				type="text"
				inputMode="numeric"
				value={value ?? ""}
				onChange={handleInputChange}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				disabled={disabled}
				className={cn(
					"flex h-full w-full grow bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
				)}
				{...props}
			/>
			<div className="flex h-full shrink-0 flex-col border-l border-input">
				<Button
					type="button"
					tabIndex={-1}
					variant="ghost"
					size="icon"
					disabled={!canIncrement}
					onClick={handleIncrement}
					className="h-1/2 w-6 rounded-none rounded-tr-md px-0 hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-30"
					aria-label="Increase value"
				>
					<ChevronUp className="size-3" />
				</Button>
				<Button
					type="button"
					tabIndex={-1}
					variant="ghost"
					size="icon"
					disabled={!canDecrement}
					onClick={handleDecrement}
					className="h-1/2 w-6 rounded-none rounded-br-md px-0 hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-30"
					aria-label="Decrease value"
				>
					<ChevronDown className="size-3" />
				</Button>
			</div>
		</div>
	);
}

export { InputNumber };
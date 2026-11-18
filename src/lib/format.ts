/**
 * Formatting utilities for shtora-cloud
 * Helper functions for dates, strings, and API responses
 */

/**
 * Format a date to ISO string or human-readable format
 */
export function formatDate(
	date: Date | string,
	format: "iso" | "relative" | "human" = "iso",
): string {
	const dateObj = typeof date === "string" ? new Date(date) : date;

	switch (format) {
		case "iso":
			return dateObj.toISOString();
		case "relative":
			return formatRelative(dateObj);
		case "human":
			return dateObj.toLocaleString();
	}
}

/**
 * Format date as relative time (e.g., "2 hours ago")
 */
export function formatRelative(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHours = Math.floor(diffMin / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffDays > 0) {
		return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
	}
	if (diffHours > 0) {
		return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
	}
	if (diffMin > 0) {
		return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
	}
	if (diffSec > 0) {
		return `${diffSec} second${diffSec !== 1 ? "s" : ""} ago`;
	}
	return "just now";
}

/**
 * Format a duration in seconds to human-readable format
 */
export function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m`;
	}
	if (seconds < 86400) {
		const hours = Math.floor(seconds / 3600);
		return `${hours}h`;
	}
	const days = Math.floor(seconds / 86400);
	return `${days}d`;
}

/**
 * Format a timestamp without milliseconds
 */
export function formatTimestamp(dateOrString: Date | string): string {
	const date =
		typeof dateOrString === "string" ? new Date(dateOrString) : dateOrString;
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Sanitize user input for safe display
 * Escapes HTML entities
 */
export function sanitizeHTML(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Truncate a string with ellipsis
 */
export function truncate(
	text: string,
	maxLength: number,
	suffix: string = "...",
): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Mask sensitive data (e.g., API keys, passwords)
 */
export function maskSensitive(text: string, visibleChars: number = 4): string {
	if (text.length <= visibleChars) {
		return "*".repeat(text.length);
	}
	return text.slice(0, visibleChars) + "*".repeat(text.length - visibleChars);
}

/**
 * Mask an email address
 */
export function maskEmail(email: string): string {
	const atIndex = email.indexOf("@");
	if (atIndex <= 1) {
		return email.replace(/@/g, "*@");
	}
	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex);
	return local.slice(0, 2) + "*".repeat(local.length - 2) + domain;
}

/**
 * Format a number with commas
 */
export function formatNumber(num: number): string {
	return num.toLocaleString();
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number, decimals = 2): string {
	if (bytes === 0) {
		return "0 B";
	}

	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${parseFloat((bytes / k ** i).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Format an API key for display
 * Shows first 8 and last 4 characters
 */
export function formatApiKey(key: string): string {
	if (key.length <= 12) {
		return maskSensitive(key);
	}
	return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/**
 * Capitalize first letter of each word
 */
export function titleCase(text: string): string {
	return text
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

/**
 * Convert snake_case to camelCase
 */
export function snakeToCamel(text: string): string {
	return text.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

/**
 * Convert camelCase to snake_case
 */
export function camelToSnake(text: string): string {
	return text.replace(/([A-Z])/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Format role for display
 */
export function formatRole(role: string): string {
	return role === "admin" ? "Admin" : "User";
}

/**
 * Format model status
 */
export function formatModelStatus(enabled: boolean): string {
	return enabled ? "Enabled" : "Disabled";
}

/**
 * Get status color class
 */
export function getStatusColor(
	status: "success" | "warning" | "danger" | "info",
): string {
	const colors: Record<string, string> = {
		success: "text-green-600 bg-green-50",
		warning: "text-yellow-600 bg-yellow-50",
		danger: "text-red-600 bg-red-50",
		info: "text-blue-600 bg-blue-50",
	};
	return colors[status];
}

/**
 * Parse and validate a scope string
 */
export function parseScopes(scopeString: string): string[] {
	return scopeString
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Format scopes for display
 */
export function formatScopes(scopes: string[]): string {
	if (scopes.length === 0 || scopes.includes("*")) {
		return "All scopes";
	}
	return scopes.join(", ");
}

/**
 * Mask partial data safely
 */
export function safeMask(text: string, show: number = 4): string {
	if (text.length <= show) {
		return "*".repeat(text.length);
	}
	return `${text.slice(0, show)}***${text.slice(-show)}`;
}

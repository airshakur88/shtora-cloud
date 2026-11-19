"use client";

import { Streamdown } from "streamdown";
import "streamdown/styles.css";

/**
 * Assistant message body: rendered markdown inside the shadcn typeset
 * container. Streamdown parses incomplete markdown while the response
 * is still streaming, so a half-written list or code fence renders
 * without waiting for the closing marker. User messages stay plain text.
 */
export function AgentMarkdown({ children }: { children: string }) {
	return (
		<div className="typeset typeset-chat text-foreground [overflow-wrap:anywhere]">
			<Streamdown parseIncompleteMarkdown>{children}</Streamdown>
		</div>
	);
}

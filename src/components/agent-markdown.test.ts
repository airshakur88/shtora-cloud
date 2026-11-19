import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AgentMarkdown } from "./agent-markdown";

test("renders markdown inside a typeset container", () => {
	const html = renderToString(
		createElement(AgentMarkdown, null, "**Bold** text\n\n- one\n- two"),
	);
	expect(html).toContain("typeset typeset-chat");
	// Streamdown renders bold as a semibold span, not a <strong>.
	expect(html).toContain('data-streamdown="strong"');
	expect(html).toContain(">Bold<");
	expect(html).toContain("<ul class=");
	expect(html).toContain("<li");
	expect(html).toContain(">one<");
	expect(html).toContain(">two<");
});

test("renders incomplete markdown without waiting for closing markers", () => {
	const html = renderToString(
		createElement(AgentMarkdown, null, "**Bold text without a closing marker"),
	);
	expect(html).toContain("typeset typeset-chat");
	expect(html).toContain("Bold text without a closing marker");
});

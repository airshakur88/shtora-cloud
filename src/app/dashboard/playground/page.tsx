"use client";

import {
	Copy,
	LoaderCircle,
	MoreVertical,
	Paperclip,
	Pencil,
	Plus,
	Send,
	Trash2,
	X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/ui/combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { apiErrorMessage } from "@/lib/api-error";
import { canonicalModelId, comboboxModelLabel } from "@/lib/model-canonical";
import {
	DEFAULT_SESSION_NAME,
	deriveSessionTitle,
} from "@/lib/playground-sessions";
import { readChatResponse } from "./chat-response";

interface SessionSummary {
	id: string;
	name: string;
	modelId: string;
	createdAtMs: number;
	updatedAtMs: number;
}

interface Attachment {
	id: string;
	name: string;
	url: string;
}

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	attachments: Attachment[];
	timestamp: number;
}

interface Model {
	id: string;
	canonical: string;
	name: string;
	/** Comma-joined provider ids exposing this model (from the catalog API). */
	platform: string;
	enabled: boolean;
}

interface Conversation {
	messages: ChatMessage[];
	draft: string;
	partial: string;
	error: string | null;
	attachments: Attachment[];
}

const emptyConversation: Conversation = {
	messages: [],
	draft: "",
	partial: "",
	error: null,
	attachments: [],
};

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const ATTACHMENT_MIME_TYPES = "image/png,image/jpeg,image/webp,image/gif";
/** Key of the client-only conversation used before the first message. */
const DRAFT_SESSION_KEY = "__draft__";
/** Maps a stored model id to the current catalog id if they refer to the same logical model. */
function resolveModelId(raw: string): string {
	const canonical = canonicalModelId(raw);
	return `shtora/${canonical}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, { cache: "no-store", ...init });
	if (!response.ok) {
		const data = (await response.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		throw new Error(
			data?.error?.message ||
				`Request failed (${response.status}). Please try again.`,
		);
	}
	return response.json();
}

export default function PlaygroundPage() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const [conversations, setConversations] = useState<
		Record<string, Conversation>
	>({});
	const [models, setModels] = useState<Model[]>([]);
	const [sessionsLoading, setSessionsLoading] = useState(true);
	const [modelsLoading, setModelsLoading] = useState(true);
	const [sessionsError, setSessionsError] = useState<string | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [operationError, setOperationError] = useState<string | null>(null);
	const [sessionsRevision, setSessionsRevision] = useState(0);
	const [sessionSearch, setSessionSearch] = useState("");
	// Model picked while no session exists yet (the draft has no session
	// to store it on). Once the first message creates the session, the
	// model lives on the session itself.
	const [pendingModelId, setPendingModelId] = useState("");

	const [historyOpen, setHistoryOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [sessionName, setSessionName] = useState("");
	const [busy, setBusy] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [uploading, setUploading] = useState(false);
	const operation = useRef<AbortController | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const renameRef = useRef<HTMLInputElement>(null);
	const renameButtonRef = useRef<HTMLButtonElement>(null);
	const conversationRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const followResponse = useRef(true);
	const activeSession = sessions.find(
		(session) => session.id === activeSessionId,
	);
	// Before the first message there is no session: the conversation lives
	// only in the client under the draft key, nothing is created server-side.
	const conversationKey = activeSessionId ?? DRAFT_SESSION_KEY;
	const conversation = conversations[conversationKey] ?? emptyConversation;
	const availableModels = models.filter((model) => model.enabled);
	const selectedModelId = activeSession
		? resolveModelId(activeSession.modelId)
		: pendingModelId || availableModels[0]?.id || "";
	const selectedModel = models.find((model) => model.id === selectedModelId);
	// Display name of the model a session uses (sessions store the raw id).
	const modelNameByCanonical = useMemo(() => {
		const map = new Map<string, string>();
		for (const model of models) map.set(model.canonical, model.name);
		return map;
	}, [models]);
	function sessionModelName(session: SessionSummary): string {
		return (
			modelNameByCanonical.get(canonicalModelId(session.modelId)) ??
			session.modelId
		);
	}
	const visibleSessions = sessions.filter((session) =>
		`${session.name} ${session.modelId} ${sessionModelName(session)}`
			.toLowerCase()
			.includes(sessionSearch.toLowerCase().trim()),
	);
	const locked = busy || submitting;
	// Sending no longer needs a session: the first message creates it.
	const canSend = Boolean(
		selectedModel?.enabled &&
			!modelsLoading &&
			!modelsError &&
			!locked &&
			!renaming,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionsRevision is a trigger, not a read — the Retry button bumps it to reload the list after a load error, even though the body never reads it.
	useEffect(() => {
		const controller = new AbortController();
		setSessionsLoading(true);
		setSessionsError(null);
		void requestJson<{ sessions: SessionSummary[] }>(
			"/api/playground/sessions",
			{ signal: controller.signal },
		)
			.then((result) => {
				if (!controller.signal.aborted) setSessions(result.sessions);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setSessionsError(
						cause instanceof Error ? cause.message : "Could not load sessions.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setSessionsLoading(false);
			});
		return () => controller.abort();
	}, [sessionsRevision]);

	useEffect(() => {
		const controller = new AbortController();
		setModelsLoading(true);
		setModelsError(null);
		void requestJson<{
			models: Model[];
			providers: { id: string; name: string }[];
		}>("/api/dashboard/catalog", {
			signal: controller.signal,
		})
			.then((result) => {
				if (controller.signal.aborted) return;
				// One entry per logical model: the router fans out across every
				// provider exposing it, so we expose shtora/<canonical> only.
				const uniqueModels = new Map<string, Model>();
				for (const model of result.models) {
					const canonical = model.canonical || model.id;
					const routedId = `shtora/${canonical}`;
					const existing = uniqueModels.get(canonical);
					if (!existing || (!existing.enabled && model.enabled)) {
						uniqueModels.set(canonical, {
							...model,
							id: routedId,
							canonical,
						});
					}
				}
				setModels([...uniqueModels.values()]);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setModelsError(
						cause instanceof Error ? cause.message : "Could not load models.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setModelsLoading(false);
			});
		return () => controller.abort();
	}, []);

	useEffect(() => () => operation.current?.abort(), []);

	useEffect(() => {
		if (renaming) renameRef.current?.focus();
		else renameButtonRef.current?.focus();
	}, [renaming]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId is a trigger, not a read — the composer regains focus when the session changes, even though the body only checks `submitting`.
	useEffect(() => {
		if (!submitting) inputRef.current?.focus();
	}, [activeSessionId, submitting]);

	// Grow the composer with its content instead of relying on a manual resize.
	// biome-ignore lint/correctness/useExhaustiveDependencies: conversation.draft is a trigger, not a read — the textarea resizes when the draft changes, even though the body only touches the DOM element.
	useEffect(() => {
		const element = inputRef.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${element.scrollHeight}px`;
	}, [conversation.draft]);

	useEffect(() => {
		if (conversation.messages.length || conversation.partial) {
			const container = conversationRef.current;
			if (container && followResponse.current)
				container.scrollTop = container.scrollHeight;
		}
	}, [conversation.messages, conversation.partial]);

	function updateConversation(id: string, update: Partial<Conversation>) {
		setConversations((current) => ({
			...current,
			[id]: { ...emptyConversation, ...current[id], ...update },
		}));
	}

	function chooseSession(id: string) {
		if (operation.current) return;
		setActiveSessionId(id);
		setRenaming(false);
		setOperationError(null);
		setHistoryOpen(false);
		followResponse.current = true;
	}

	// Back to an unsent draft: no session is created, the composer just
	// works against the client-only draft conversation.
	function startDraft() {
		if (operation.current) return;
		setActiveSessionId(null);
		setRenaming(false);
		setOperationError(null);
		setHistoryOpen(false);
		followResponse.current = true;
	}

	async function mutateSession(
		method: "PATCH" | "DELETE",
		session?: SessionSummary,
		updates?: { name?: string; modelId?: string },
	) {
		if (operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setOperationError(null);
		try {
			const result = await requestJson<SessionSummary>(
				session
					? `/api/playground/sessions/${session.id}`
					: "/api/playground/sessions",
				{
					method,
					headers: { "Content-Type": "application/json" },
					body:
						method === "DELETE"
							? undefined
							: JSON.stringify(updates ?? { modelId: selectedModelId }),
					signal: controller.signal,
				},
			);
			if (controller.signal.aborted) return;
			if (method === "DELETE" && session) {
				setSessions((current) =>
					current.filter((item) => item.id !== session.id),
				);
				setConversations((current) => {
					const next = { ...current };
					delete next[session.id];
					return next;
				});
				setActiveSessionId(null);
			} else {
				setSessions((current) => [
					result,
					...current.filter((item) => item.id !== result.id),
				]);
				setActiveSessionId(result.id);
			}
			setRenaming(false);
			setHistoryOpen(false);
		} catch (cause) {
			if (!controller.signal.aborted)
				setOperationError(
					cause instanceof Error
						? cause.message
						: "Could not update this session. Please try again.",
				);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
			operation.current = null;
		}
	}

	async function copySessionId() {
		if (!activeSession) return;
		try {
			await navigator.clipboard.writeText(activeSession.id);
			toast.add({ title: "Session ID copied" });
		} catch {
			setOperationError(
				"Could not copy the session ID. Check clipboard permissions and try again.",
			);
		}
	}

	async function uploadAttachments(files: FileList | null) {
		if (!files || files.length === 0) return;
		const selected = Array.from(files);
		const current = conversation.attachments;
		if (current.length + selected.length > MAX_ATTACHMENTS) {
			setOperationError(
				`Maximum ${MAX_ATTACHMENTS} images per message. Remove some before adding more.`,
			);
			return;
		}
		const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_BYTES);
		if (oversized) {
			setOperationError(`"${oversized.name}" exceeds the 10 MB limit.`);
			return;
		}
		const unsupported = selected.find(
			(file) => !ATTACHMENT_MIME_TYPES.split(",").includes(file.type),
		);
		if (unsupported) {
			setOperationError(
				`"${unsupported.name}" is not a supported image (PNG, JPEG, WebP or GIF).`,
			);
			return;
		}

		setUploading(true);
		setOperationError(null);
		try {
			const body = new FormData();
			for (const file of selected) body.append("images", file);
			const response = await fetch("/api/playground/images", {
				method: "POST",
				body,
			});
			const result: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				setOperationError(
					apiErrorMessage(result, "Could not upload the images."),
				);
				return;
			}
			if (
				!result ||
				typeof result !== "object" ||
				!("images" in result) ||
				!Array.isArray(result.images)
			)
				throw new Error("Invalid upload response.");
			const uploaded: Attachment[] = result.images.map((image) => ({
				id: crypto.randomUUID(),
				name: String(image.name),
				url: String(image.url),
			}));
			updateConversation(conversationKey, {
				attachments: [...current, ...uploaded],
			});
		} catch (cause) {
			setOperationError(
				cause instanceof Error ? cause.message : "Could not upload the images.",
			);
		} finally {
			setUploading(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	}

	function removeAttachment(id: string) {
		updateConversation(conversationKey, {
			attachments: conversation.attachments.filter(
				(attachment) => attachment.id !== id,
			),
		});
	}

	async function submit() {
		if (
			!canSend ||
			(!conversation.draft.trim() && !conversation.attachments.length) ||
			operation.current
		)
			return;
		const controller = new AbortController();
		operation.current = controller;
		// The conversation lives under the draft key until the first message
		// creates a real session; after creation it moves to the session id.
		let key = conversationKey;
		const previousMessages = conversation.messages;
		const draft = conversation.draft;
		const attachments = conversation.attachments;
		const nextMessages: ChatMessage[] = [
			...previousMessages,
			{
				id: crypto.randomUUID(),
				role: "user",
				content: draft.trim(),
				attachments,
				timestamp: Date.now(),
			},
		];
		const isFirstMessage = previousMessages.length === 0;
		const derivedTitle = isFirstMessage ? deriveSessionTitle(draft) : null;
		setSubmitting(true);
		followResponse.current = true;
		updateConversation(key, {
			messages: nextMessages,
			draft: "",
			partial: "",
			error: null,
			attachments: [],
		});
		try {
			let sessionId = activeSessionId;
			if (!sessionId) {
				// Lazy creation: exactly one session, created on first send.
				// `operation.current` is already set, so a double submit
				// returns early above and cannot create a second one.
				const created = await requestJson<SessionSummary>(
					"/api/playground/sessions",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ modelId: selectedModelId }),
						signal: controller.signal,
					},
				);
				if (controller.signal.aborted) return;
				sessionId = created.id;
				const createdSession = derivedTitle
					? { ...created, name: derivedTitle }
					: created;
				setSessions((current) => [
					createdSession,
					...current.filter((item) => item.id !== created.id),
				]);
				setActiveSessionId(created.id);
				setConversations((current) => {
					const next = { ...current };
					const draftConversation =
						next[DRAFT_SESSION_KEY] ?? emptyConversation;
					delete next[DRAFT_SESSION_KEY];
					next[created.id] = { ...emptyConversation, ...draftConversation };
					return next;
				});
				key = created.id;
			} else if (
				isFirstMessage &&
				derivedTitle &&
				activeSession?.name === DEFAULT_SESSION_NAME
			) {
				// Existing session that never got a message (e.g. created
				// before lazy creation): title it from this first message.
				// The server does the same; this only updates the list
				// immediately, without a reload.
				setSessions((current) =>
					current.map((item) =>
						item.id === sessionId ? { ...item, name: derivedTitle } : item,
					),
				);
			}
			const response = await fetch("/api/playground/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId,
					modelId: selectedModelId,
					messages: nextMessages.map(({ role, content, attachments }) => ({
						role,
						content: attachments.length
							? [
									{ type: "text", text: content },
									...attachments.map((attachment) => ({
										type: "image_url",
										image_url: { url: attachment.url },
									})),
								]
							: content,
					})),
				}),
				signal: controller.signal,
			});
			const content = await readChatResponse(response, (partial) => {
				if (!controller.signal.aborted) updateConversation(key, { partial });
			});
			if (!controller.signal.aborted)
				updateConversation(key, {
					messages: [
						...nextMessages,
						{
							id: crypto.randomUUID(),
							role: "assistant",
							content,
							attachments: [],
							timestamp: Date.now(),
						},
					],
					partial: "",
				});
		} catch (cause) {
			if (!controller.signal.aborted)
				updateConversation(key, {
					messages: previousMessages,
					draft,
					attachments,
					error:
						cause instanceof Error
							? cause.message
							: "Could not get a response. Please try again.",
				});
		} finally {
			if (!controller.signal.aborted) {
				setSubmitting(false);
			}
			operation.current = null;
		}
	}
	return (
		<div className="flex h-dvh flex-col">
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden border bg-card">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
					<aside
						id="playground-sessions"
						aria-label="Chat sessions"
						className={`${historyOpen ? "flex" : "hidden"} max-h-80 flex-col border-b bg-muted/50 lg:flex lg:max-h-none lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0 xl:w-72`}
					>
						<div className="space-y-4 p-4">
							<div className="flex items-center justify-between gap-2">
								<h2 className="text-sm font-semibold text-foreground">
									Sessions
								</h2>
								<Button
									variant="outline"
									size="sm"
									className="hidden lg:inline-flex"
									disabled={
										locked ||
										sessionsLoading ||
										Boolean(sessionsError) ||
										modelsLoading ||
										!availableModels.length
									}
									onClick={() => startDraft()}
								>
									<Plus className="size-4" aria-hidden="true" /> New session
								</Button>
							</div>
							<Input
								aria-label="Search sessions"
								placeholder="Search sessions"
								value={sessionSearch}
								onChange={(event) => setSessionSearch(event.target.value)}
								className="bg-card"
							/>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 lg:max-h-[36rem]">
							{sessionsLoading ? (
								<div
									className="space-y-2 px-2"
									role="status"
									aria-label="Loading sessions"
								>
									<Skeleton className="h-16 w-full" />
									<Skeleton className="h-16 w-full" />
									<Skeleton className="h-16 w-full" />
								</div>
							) : sessionsError ? (
								<div className="space-y-3 p-2">
									<p role="alert" className="text-sm text-destructive">
										{sessionsError}
									</p>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setSessionsRevision((value) => value + 1)}
									>
										Retry sessions
									</Button>
								</div>
							) : visibleSessions.length ? (
								<ul className="space-y-1">
									{visibleSessions.map((session) => (
										<li key={session.id} className="group relative">
											<button
												type="button"
												disabled={locked}
												aria-current={
													session.id === activeSessionId ? "true" : undefined
												}
												onClick={() => chooseSession(session.id)}
												className={`w-full rounded-md border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${session.id === activeSessionId ? "border-border bg-card shadow-sm" : "border-transparent hover:bg-muted/50"}`}
											>
												<span className="block truncate text-sm font-medium text-foreground">
													{session.name}
												</span>
												<span className="mt-1 block truncate text-xs text-muted-foreground">
													{sessionModelName(session)}
												</span>
											</button>
											<div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
												<DropdownMenu>
													<DropdownMenuTrigger disabled={locked}>
														<Button
															variant="ghost"
															size="icon"
															className="h-7 w-7"
															aria-label={`Session actions for ${session.name}`}
														>
															<MoreVertical
																aria-hidden="true"
																className="size-4"
															/>
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onClick={() => {
																setActiveSessionId(session.id);
																setSessionName(session.name);
																setRenaming(true);
															}}
														>
															<Pencil aria-hidden="true" className="size-4" />
															Rename
														</DropdownMenuItem>
														<DropdownMenuItem
															onClick={() => {
																if (
																	window.confirm(
																		`Delete “${session.name}”? This cannot be undone.`,
																	)
																)
																	void mutateSession("DELETE", session);
															}}
															variant="destructive"
														>
															<Trash2 aria-hidden="true" className="size-4" />
															Delete
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</li>
									))}
								</ul>
							) : (
								<p className="px-2 py-6 text-sm text-muted-foreground">
									{sessionSearch
										? "No sessions match your search."
										: "Your sessions will appear here."}
								</p>
							)}
						</div>
					</aside>

					<section
						aria-label="Conversation workspace"
						className="flex min-h-0 min-w-0 flex-1 flex-col"
					>
						{operationError ? (
							<div className="flex items-start justify-between gap-3 border-b bg-destructive/10 px-4 py-3">
								<p role="alert" className="text-sm text-destructive">
									{operationError}
								</p>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setOperationError(null)}
								>
									Dismiss
								</Button>
							</div>
						) : null}
						<div className="shrink-0 space-y-4 border-b p-4 sm:p-6">
							<div className="flex flex-wrap items-center justify-between gap-3">
								{renaming && activeSession ? (
									<form
										className="flex min-w-0 flex-1 flex-wrap items-end gap-2"
										onSubmit={(event) => {
											event.preventDefault();
											if (sessionName.trim())
												void mutateSession("PATCH", activeSession, {
													name: sessionName.trim(),
												});
										}}
									>
										<div className="min-w-0 flex-1">
											<label
												htmlFor="session-name"
												className="mb-1 block text-xs font-medium text-muted-foreground"
											>
												Session name
											</label>
											<Input
												ref={renameRef}
												id="session-name"
												value={sessionName}
												disabled={busy}
												required
												onChange={(event) => setSessionName(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Escape" && !busy)
														setRenaming(false);
												}}
											/>
										</div>
										<Button
											type="submit"
											disabled={busy || !sessionName.trim()}
										>
											{busy ? "Saving…" : "Save"}
										</Button>
										<Button
											type="button"
											variant="ghost"
											disabled={busy}
											onClick={() => setRenaming(false)}
										>
											Cancel
										</Button>
									</form>
								) : (
									<>
										<h2 className="min-w-0 flex-1 truncate font-semibold text-foreground">
											{activeSession?.name ?? "New conversation"}
										</h2>
										{activeSession ? (
											<div className="flex items-center gap-1">
												<Button
													ref={renameButtonRef}
													variant="ghost"
													size="icon"
													aria-label="Rename session"
													title="Rename session"
													disabled={locked}
													onClick={() => {
														setSessionName(activeSession.name);
														setRenaming(true);
													}}
												>
													<Pencil className="size-4" aria-hidden="true" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													aria-label="Copy session ID"
													title="Copy session ID"
													onClick={() => void copySessionId()}
												>
													<Copy className="size-4" aria-hidden="true" />
												</Button>
												<Button
													variant="ghost"
													size="icon"
													className="text-destructive hover:text-destructive/80"
													aria-label="Delete session"
													title="Delete session"
													disabled={locked}
													onClick={() => {
														if (
															window.confirm(
																`Delete “${activeSession.name}”? This cannot be undone.`,
															)
														)
															void mutateSession("DELETE", activeSession);
													}}
												>
													<Trash2 className="size-4" aria-hidden="true" />
												</Button>
											</div>
										) : null}
									</>
								)}
							</div>
						</div>

						<section
							ref={conversationRef}
							aria-label="Chat messages"
							onScroll={(event) => {
								const element = event.currentTarget;
								followResponse.current =
									element.scrollHeight -
										element.scrollTop -
										element.clientHeight <
									80;
							}}
							className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6"
						>
							{!conversation.messages.length && !conversation.partial ? (
								<div className="mx-auto flex h-full max-w-sm flex-col justify-center gap-2 text-center">
									<h3 className="font-medium text-foreground">
										What would you like to try?
									</h3>
									<p className="text-sm leading-6 text-muted-foreground">
										Send a prompt to{" "}
										{selectedModel?.name ?? "your selected model"}.
									</p>
								</div>
							) : (
								<ol className="mx-auto max-w-3xl space-y-6">
									{conversation.messages.map((message) => (
										<li
											key={message.id}
											className={
												message.role === "user"
													? "rounded-lg bg-muted/30 p-4"
													: "px-4"
											}
										>
											<p className="mb-2 text-xs font-semibold text-muted-foreground">
												{message.role === "user" ? "You" : "Assistant"}
											</p>
											<p className="whitespace-pre-wrap text-sm leading-7 text-foreground [overflow-wrap:anywhere]">
												{message.content}
											</p>
										</li>
									))}
									{conversation.partial ? (
										<li className="px-4">
											<p className="mb-2 text-xs font-semibold text-muted-foreground">
												{conversation.error
													? "Assistant · Incomplete response"
													: "Assistant"}
											</p>
											<p className="whitespace-pre-wrap text-sm leading-7 text-foreground [overflow-wrap:anywhere]">
												{conversation.partial}
											</p>
										</li>
									) : null}
								</ol>
							)}
							{submitting ? (
								<p
									role="status"
									className="mx-auto mt-4 max-w-3xl px-4 text-sm text-muted-foreground"
								>
									{conversation.partial
										? "Receiving response…"
										: "Waiting for the model…"}
								</p>
							) : null}
						</section>

						<form
							className="sticky bottom-0 shrink-0 space-y-3 border-t bg-card p-4 sm:px-6"
							onSubmit={(event) => {
								event.preventDefault();
								void submit();
							}}
						>
							{conversation.error ? (
								<div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3">
									<p
										id="chat-error"
										role="alert"
										className="text-sm text-destructive"
									>
										{conversation.error}
									</p>
									<Button
										variant="outline"
										size="sm"
										disabled={!canSend || !conversation.draft.trim()}
										onClick={() => void submit()}
									>
										Retry message
									</Button>
								</div>
							) : null}
							<div className="mx-auto max-w-3xl">
								<div className="mb-3 flex items-center justify-between gap-3">
									<label
										htmlFor="playground-model"
										className="text-xs font-medium text-muted-foreground"
									>
										Model
									</label>
									{modelsLoading ? (
										<Skeleton className="h-8 w-56" />
									) : modelsError ? (
										<p className="text-xs text-destructive">{modelsError}</p>
									) : availableModels.length ? (
										<Combobox
											// The items prop is what Base UI filters: without
											// it the filtered list is always empty, so the
											// popup is always data-empty and "No models
											// available" shows next to the full list.
											items={availableModels.map((model) => model.id)}
											value={selectedModelId}
											// The input shows the selected item's label: without
											// this it falls back to the raw value (the model id).
											itemToStringLabel={(value) => {
												const model = models.find((m) => m.id === value);
												return model
													? comboboxModelLabel(model.name)
													: String(value);
											}}
											onValueChange={(value) => {
												if (typeof value !== "string") return;
												if (activeSession) {
													if (value !== selectedModelId)
														void mutateSession("PATCH", activeSession, {
															modelId: value,
														});
												} else {
													setPendingModelId(value);
												}
											}}
											disabled={
												locked ||
												renaming ||
												modelsLoading ||
												!availableModels.length
											}
										>
											<ComboboxInput
												placeholder="Select model..."
												className="h-9 w-full max-w-72 min-w-0 truncate rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
											/>
											<ComboboxContent>
												<ComboboxList>
													{(id: string) => {
														const model = models.find((m) => m.id === id);
														if (!model) return null;
														return (
															<ComboboxItem key={model.id} value={model.id}>
																{comboboxModelLabel(model.name)}
															</ComboboxItem>
														);
													}}
												</ComboboxList>
												<ComboboxEmpty>No models available</ComboboxEmpty>
											</ComboboxContent>
										</Combobox>
									) : null}
								</div>
								<label htmlFor="chat-message" className="sr-only">
									Message
								</label>
								{conversation.attachments.length ? (
									<ul className="mb-2 flex flex-wrap gap-2">
										{conversation.attachments.map((attachment) => (
											<li
												key={attachment.id}
												className="group relative size-16 overflow-hidden rounded-md border border-border"
											>
												<Image
													src={attachment.url}
													alt={attachment.name}
													width={64}
													height={64}
													unoptimized
													className="size-full object-cover"
												/>
												<button
													type="button"
													onClick={() => removeAttachment(attachment.id)}
													aria-label={`Remove ${attachment.name}`}
													className="absolute top-0 right-0 flex size-5 items-center justify-center bg-background/90 text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
												>
													<X className="size-3" aria-hidden="true" />
												</button>
											</li>
										))}
									</ul>
								) : null}
								<div className="flex items-end gap-2 rounded-lg border p-2 focus-within:ring-2 focus-within:ring-ring">
									<input
										ref={fileInputRef}
										id="playground-images"
										type="file"
										accept={ATTACHMENT_MIME_TYPES}
										multiple
										className="sr-only"
										onChange={(event) =>
											void uploadAttachments(event.target.files)
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="min-h-10 shrink-0"
										disabled={
											locked ||
											renaming ||
											uploading ||
											modelsLoading ||
											!availableModels.length ||
											conversation.attachments.length >= MAX_ATTACHMENTS
										}
										aria-label="Attach images"
										title="Attach images (max 10 MB each, 10 per message)"
										onClick={() => fileInputRef.current?.click()}
									>
										{uploading ? (
											<LoaderCircle
												className="size-4 animate-spin"
												aria-hidden="true"
											/>
										) : (
											<Paperclip className="size-4" aria-hidden="true" />
										)}
									</Button>
									<textarea
										ref={inputRef}
										id="chat-message"
										value={conversation.draft}
										disabled={
											locked ||
											renaming ||
											modelsLoading ||
											Boolean(modelsError) ||
											!availableModels.length
										}
										aria-describedby={`composer-hint${conversation.error ? " chat-error" : ""}`}
										onChange={(event) => {
											updateConversation(conversationKey, {
												draft: event.target.value,
											});
										}}
										onKeyDown={(event) => {
											if (
												event.key === "Enter" &&
												!event.shiftKey &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault();
												void submit();
											}
										}}
										placeholder={
											availableModels.length
												? "Write a message…"
												: "Loading models…"
										}
										rows={1}
										className="max-h-48 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-1 text-sm leading-6 outline-none disabled:cursor-not-allowed disabled:opacity-60"
									/>
									<Button
										type="submit"
										className="min-h-10 shrink-0"
										disabled={
											!canSend ||
											(!conversation.draft.trim() &&
												!conversation.attachments.length)
										}
									>
										<Send className="size-4" aria-hidden="true" />
										<span className="hidden sm:inline">
											{submitting ? "Sending…" : "Send"}
										</span>
										<span className="sr-only sm:hidden">Send message</span>
									</Button>
								</div>
								<p
									id="composer-hint"
									className="mt-2 text-xs leading-5 text-muted-foreground"
								>
									{submitting
										? "Wait for the response before switching sessions."
										: activeSession && !selectedModel?.enabled && !modelsLoading
											? "Choose an enabled model to send messages."
											: "Enter to send · Shift + Enter for a new line"}
								</p>
								<p className="text-xs leading-5 text-muted-foreground">
									Messages are kept until you reload this page.
								</p>
							</div>
						</form>
					</section>
				</div>
			</div>
		</div>
	);
}

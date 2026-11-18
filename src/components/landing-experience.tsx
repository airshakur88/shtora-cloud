"use client";

import { Check, Copy } from "lucide-react";
import Image from "next/image";
import { createRef, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatedBeam } from "@/components/magicui/animated-beam";
import { cn } from "@/lib/utils";

interface ProviderLeaf {
	name: string;
	slug: string;
	endpointHint: string;
}

interface RoutingBranch {
	id: string;
	title: string;
	rule: string;
	providers: ProviderLeaf[];
}

const ROUTING_BRANCHES: RoutingBranch[] = [
	{
		id: "keyless",
		title: "Sem chave",
		rule: "Zero setup · pronto na hora",
		providers: [
			{
				name: "OVH AI",
				slug: "ovh",
				endpointHint: "9 modelos gratuitos · sem API key",
			},
			{
				name: "Kilo Gateway",
				slug: "kilo",
				endpointHint: "5 modelos gratuitos · sem API key",
			},
			{
				name: "AI Horde",
				slug: "aihorde",
				endpointHint: "Cluster comunitário gratuito · sem API key",
			},
		],
	},
	{
		id: "speed",
		title: "Inferência rápida",
		rule: "Prioridade por baixa latência",
		providers: [
			{
				name: "Groq",
				slug: "groq",
				endpointHint: "4 modelos gratuitos · LPU de baixa latência",
			},
			{
				name: "Cerebras",
				slug: "cerebras",
				endpointHint: "Tier gratuito · inferência wafer-scale",
			},
			{
				name: "Cloudflare AI",
				slug: "cloudflare",
				endpointHint: "21 modelos gratuitos · Workers edge",
			},
		],
	},
	{
		id: "labs",
		title: "Labs principais",
		rule: "Suas chaves + pool da comunidade",
		providers: [
			{
				name: "Google AI Studio",
				slug: "google",
				endpointHint: "8 modelos gratuitos · família Gemini & Gemma",
			},
			{
				name: "Mistral",
				slug: "mistral",
				endpointHint: "4 modelos gratuitos · La Plateforme",
			},
			{
				name: "NVIDIA NIM",
				slug: "nvidia",
				endpointHint: "5 modelos gratuitos · catálogo NIM",
			},
			{
				name: "Cohere",
				slug: "cohere",
				endpointHint: "11 modelos gratuitos · Command & Embed",
			},
			{
				name: "xAI",
				slug: "xai",
				endpointHint: "Tier gratuito · protocolo compatível OpenAI",
			},
		],
	},
	{
		id: "pools",
		title: "Pools & roteadores",
		rule: "Fallback automático em cadeia · shtora/auto, coding, fast, smart e vision",
		providers: [
			{
				name: "OpenRouter",
				slug: "openrouter",
				endpointHint: "5 modelos :free · roteamento multi-provedor",
			},
			{
				name: "Together",
				slug: "together",
				endpointHint: "Tier gratuito · modelos open-weights",
			},
			{
				name: "Hugging Face",
				slug: "huggingface",
				endpointHint: "Tier gratuito · Inference Providers",
			},
			{
				name: "SiliconFlow",
				slug: "siliconflow",
				endpointHint: "Tier gratuito · Qwen & DeepSeek",
			},
		],
	},
];

const WRAP =
	"w-[min(1400px,calc(100%-64px))] max-[1100px]:w-[calc(100%-48px)] max-[480px]:w-[calc(100%-32px)] mx-auto";
const EYEBROW =
	"m-0 mb-5 flex items-center gap-[9px] font-[ui-monospace,Consolas,monospace] text-xs leading-[1.5] tracking-[1.4px] text-[#e3ab88] max-[480px]:text-[11px] max-[480px]:tracking-[1px]";
const H2 =
	"m-0 mb-5 text-[clamp(28px,2.8vw,40px)] leading-[1.18] font-[450] tracking-[-1.3px] max-[480px]:text-[28px] max-[480px]:tracking-[-1px]";
const FOCUS_VISIBLE =
	"focus-visible:outline-2 focus-visible:outline-[#e3ab88] focus-visible:outline-offset-[5px]";
const MONO = "font-[ui-monospace,Consolas,monospace]";

export function RequestLayers() {
	const stageRef = useRef<HTMLDivElement>(null);
	const originRef = useRef<HTMLDivElement>(null);
	const hubRef = useRef<HTMLDivElement>(null);
	const branchRefs = useMemo(
		() => ROUTING_BRANCHES.map(() => createRef<HTMLButtonElement>()),
		[],
	);

	const [activeBranchId, setActiveBranchId] = useState<string>(
		ROUTING_BRANCHES[0].id,
	);
	const [activeProviderSlug, setActiveProviderSlug] = useState<string>(
		ROUTING_BRANCHES[0].providers[0].slug,
	);

	const activeBranch =
		ROUTING_BRANCHES.find((branch) => branch.id === activeBranchId) ??
		ROUTING_BRANCHES[0];
	const activeProvider =
		activeBranch.providers.find(
			(provider) => provider.slug === activeProviderSlug,
		) ?? activeBranch.providers[0];

	function selectBranch(branch: RoutingBranch) {
		setActiveBranchId(branch.id);
		if (!branch.providers.some((p) => p.slug === activeProviderSlug)) {
			setActiveProviderSlug(branch.providers[0].slug);
		}
	}

	function selectProvider(branch: RoutingBranch, provider: ProviderLeaf) {
		setActiveBranchId(branch.id);
		setActiveProviderSlug(provider.slug);
	}

	return (
		<section
			className="scroll-mt-7 border-t border-[#2a2b2e] bg-[#0c0d0f] py-24"
			id="como-funciona"
			aria-label="Como funciona o roteamento"
		>
			<div className={WRAP}>
				<div className="mb-9 flex flex-wrap items-end justify-between gap-8">
					<div>
						<p className={EYEBROW}>
							<span className="inline-block size-[6px] shrink-0 rounded-full bg-[#e3ab88]" />{" "}
							MAPA MENTAL DE ROTEAMENTO
						</p>
						<h2 className={cn(H2, "mb-0")}>
							O caminho da sua
							<br />
							<span className="text-[#96928d]">requisição.</span>
						</h2>
					</div>
					<p className="m-0 max-w-[490px] text-[15.5px] leading-[1.75] text-[#aaa6a1] text-pretty">
						Um único endpoint ramifica sua chamada pelo gateway{" "}
						<code className={cn(MONO, "text-[13px] text-[#e3ab88]")}>s.</code>{" "}
						até 49 provedores gratuitos — com pool comunitário e failover
						silencioso. Clique ou passe o cursor para inspecionar uma rota.
					</p>
				</div>

				<div className="rounded-[20px] border border-[color-mix(in_srgb,#2a2b2e_85%,transparent)] bg-[#0e0f12] bg-[radial-gradient(ellipse_54%_46%_at_50%_34%,rgba(227,171,136,0.085),transparent_70%),radial-gradient(rgba(238,234,229,0.07)_1px,transparent_1px)] bg-[length:100%_100%,24px_24px] px-8 pt-9 pb-[22px] max-[1024px]:px-5 max-[1024px]:pt-[26px] max-[1024px]:pb-5">
					<div className="relative" ref={stageRef}>
						<div
							className="pointer-events-none absolute inset-0 z-0 max-[1024px]:hidden"
							aria-hidden="true"
						>
							<AnimatedBeam
								containerRef={stageRef}
								fromRef={originRef}
								toRef={hubRef}
								orientation="vertical"
								pathColor="#9d7051"
								pathOpacity={0.5}
								pathWidth={2}
								gradientStartColor="#f5c5a6"
								gradientStopColor="#e3ab88"
								duration={2.6}
							/>
							{ROUTING_BRANCHES.map((branch, index) => {
								const isSelected = branch.id === activeBranch.id;
								return (
									<AnimatedBeam
										key={branch.id}
										containerRef={stageRef}
										fromRef={hubRef}
										toRef={branchRefs[index]}
										orientation="vertical"
										pathColor={isSelected ? "#e3ab88" : "#514134"}
										pathOpacity={isSelected ? 0.65 : 0.35}
										pathWidth={isSelected ? 2 : 1.5}
										gradientStartColor="#f5c5a6"
										gradientStopColor="#c98d63"
										duration={isSelected ? 2.4 : 4.2}
										delay={index * 0.35}
									/>
								);
							})}
						</div>

						<div className="relative z-[1] flex flex-col items-center">
							<div className="mb-[52px] w-[min(260px,100%)] max-[1024px]:mb-0">
								<div className="w-full rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.025)] p-1">
									<div
										className="flex flex-col items-center gap-[3px] rounded-[10px] bg-[#131417] px-[14px] py-3 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
										ref={originRef}
									>
										<span
											className={cn(
												MONO,
												"text-[10.5px] leading-[1.2] tracking-[1.3px] text-[#e3ab88]",
											)}
										>
											ENTRADA ÚNICA
										</span>
										<strong className="mt-[2px] text-[15px] font-[550] tracking-[-0.2px]">
											Sua Aplicação
										</strong>
										<code
											className={cn(
												MONO,
												"mt-[2px] text-[11.5px] leading-[1.4] text-[#d4c6b8]",
											)}
										>
											POST /v1/chat/completions
										</code>
										<span
											className={cn(
												MONO,
												"text-[11.5px] leading-[1.4] text-[#aaa6a1]",
											)}
										>
											model: &ldquo;shtora/&lt;modelo&gt;&rdquo;
										</span>
									</div>
								</div>
							</div>

							<div
								className="hidden h-5 w-px bg-[rgba(227,171,136,0.45)] max-[1024px]:block max-[1024px]:mx-auto"
								aria-hidden="true"
							/>

							<div className="mb-16 w-[min(200px,100%)] max-[1024px]:mb-0">
								<div className="w-full rounded-[18px] border border-[rgba(227,171,136,0.3)] bg-[rgba(227,171,136,0.06)] p-[5px] shadow-[0_0_48px_rgba(227,171,136,0.12)]">
									<div
										className="flex flex-col items-center gap-[3px] rounded-[13px] bg-[#1b1612] px-[14px] py-[14px] text-center shadow-[inset_0_1px_0_rgba(227,171,136,0.22)]"
										ref={hubRef}
									>
										<span
											className="mb-[2px] font-[Georgia,serif] text-[32px] leading-[0.9] font-bold text-[#e3ab88] italic"
											aria-hidden="true"
										>
											s.
										</span>
										<strong className="text-[15px] font-semibold tracking-[-0.2px] text-[#f5e6d8]">
											Shtora Cloud
										</strong>
										<span
											className={cn(
												MONO,
												"text-[11px] leading-[1.4] tracking-[0.3px] text-[#b79c86]",
											)}
										>
											Pool · Failover · Grátis
										</span>
									</div>
								</div>
							</div>

							<div
								className="hidden h-5 w-px bg-[rgba(227,171,136,0.45)] max-[1024px]:block max-[1024px]:mx-auto"
								aria-hidden="true"
							/>

							<ul className="m-0 grid w-full list-none grid-cols-[repeat(4,minmax(0,1fr))] items-start gap-5 p-0 max-[1024px]:grid-cols-2 max-[640px]:grid-cols-1">
								{ROUTING_BRANCHES.map((branch, index) => {
									const isBranchActive = branch.id === activeBranch.id;
									return (
										<li key={branch.id} className="flex flex-col items-stretch">
											<button
												ref={branchRefs[index]}
												type="button"
												className={cn(
													"relative flex w-full flex-col items-start gap-[2px] rounded-[10px] border border-[#2b2c30] bg-[#131417] px-[13px] py-[10px] text-left text-[#eeeae5] transition-[transform_180ms_cubic-bezier(0.23,1,0.32,1),border-color_180ms_cubic-bezier(0.23,1,0.32,1),background-color_180ms_cubic-bezier(0.23,1,0.32,1)] before:absolute before:top-[-4px] before:left-1/2 before:size-[7px] before:-translate-x-1/2 before:rounded-full before:border before:border-[#675243] before:bg-[#3a342e] before:transition-[background-color_180ms_cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] hover:border-[#7c5c46]",
													FOCUS_VISIBLE,
													isBranchActive &&
														"border-[#9d7051] bg-[#1b1612] before:bg-[#e3ab88]",
												)}
												aria-pressed={isBranchActive}
												onClick={() => selectBranch(branch)}
												onMouseEnter={() => selectBranch(branch)}
											>
												<span
													className={cn(
														"text-[14px] font-[550] tracking-[-0.2px] text-[#eeeae5]",
														isBranchActive && "text-[#f5c5a6]",
													)}
												>
													{branch.title}
												</span>
												<span className="text-xs leading-[1.35] text-[#aaa6a1]">
													{branch.rule}
												</span>
											</button>

											<div
												className={cn(
													"relative mt-3 ml-4 flex flex-col items-start gap-[7px] border-l border-[#2f2c28] pl-4 transition-[border-color_180ms_cubic-bezier(0.23,1,0.32,1)] before:absolute before:-top-3 before:-left-px before:h-3 before:w-px before:bg-[#2f2c28]",
													isBranchActive &&
														"border-l-[rgba(227,171,136,0.6)] before:bg-[rgba(227,171,136,0.6)]",
												)}
											>
												{branch.providers.map((provider) => {
													const isProviderActive =
														isBranchActive &&
														provider.slug === activeProvider.slug;
													return (
														<button
															key={provider.slug}
															type="button"
															className={cn(
																"relative inline-flex max-w-full items-center gap-2 rounded-full border border-[#27282d] bg-[#121316] py-[5px] pr-[11px] pl-[5px] text-[13px] leading-[1.2] font-medium text-[#cbc6c0] transition-[transform_180ms_cubic-bezier(0.23,1,0.32,1),border-color_180ms_cubic-bezier(0.23,1,0.32,1),background-color_180ms_cubic-bezier(0.23,1,0.32,1),color_180ms_cubic-bezier(0.23,1,0.32,1)] before:absolute before:top-1/2 before:-left-[17px] before:h-px before:w-4 before:bg-[#2f2c28] before:transition-[background-color_180ms_cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] hover:translate-x-[2px] hover:border-[#9d7051] hover:text-[#eeeae5]",
																FOCUS_VISIBLE,
																isBranchActive &&
																	"before:bg-[rgba(227,171,136,0.45)]",
																isProviderActive &&
																	"border-[#e3ab88] bg-[#211a15] text-[#eeeae5] before:bg-[#e3ab88]",
															)}
															aria-pressed={isProviderActive}
															onClick={() => selectProvider(branch, provider)}
															onMouseEnter={() =>
																selectProvider(branch, provider)
															}
														>
															<span className="inline-flex size-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full border border-[rgba(255,255,255,0.16)] bg-[#eeeae5]">
																<Image
																	src={`/providers/${provider.slug}.png`}
																	width={14}
																	height={14}
																	alt=""
																	aria-hidden="true"
																	unoptimized
																/>
															</span>
															<span>{provider.name}</span>
														</button>
													);
												})}
											</div>
										</li>
									);
								})}
							</ul>
						</div>
					</div>

					<div
						className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-[color-mix(in_srgb,#2a2b2e_75%,transparent)] pt-[18px]"
						role="status"
						aria-live="polite"
					>
						<div
							className={cn(
								MONO,
								"flex flex-wrap items-center gap-2 text-[12.5px]",
							)}
						>
							<span className="text-[#aaa6a1]">Sua Aplicação</span>
							<span className="text-[#5c4938]" aria-hidden="true">
								→
							</span>
							<span className="text-[#e3ab88]">s. Gateway</span>
							<span className="text-[#5c4938]" aria-hidden="true">
								→
							</span>
							<span className="text-[#aaa6a1]">{activeBranch.title}</span>
							<span className="text-[#5c4938]" aria-hidden="true">
								→
							</span>
							<span className="inline-flex items-center gap-[7px] text-[#eeeae5]">
								<span className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[rgba(255,255,255,0.16)] bg-[#eeeae5]">
									<Image
										src={`/providers/${activeProvider.slug}.png`}
										width={14}
										height={14}
										alt=""
										aria-hidden="true"
										unoptimized
									/>
								</span>
								<strong className="font-semibold">{activeProvider.name}</strong>
							</span>
						</div>
						<p className="m-0 text-[13px] text-[#aaa6a1]">
							{activeProvider.endpointHint} · Todos os provedores oferecem
							modelos gratuitos (+34 no catálogo)
						</p>
					</div>
				</div>
			</div>
		</section>
	);
}

const examples = {
	OpenAI: (origin: string) =>
		`import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${origin}/v1",\n  apiKey: process.env.SHTORA_API_KEY,\n});\n\nconst response = await client.chat.completions.create({\n  model: "shtora/gpt-oss-120b",\n  messages: [{ role: "user", content: "Olá, Shtora." }],\n});`,
	Anthropic: (origin: string) =>
		`import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({\n  baseURL: "${origin}",\n  apiKey: process.env.SHTORA_API_KEY,\n});\n\nconst response = await client.messages.create({\n  model: "shtora/gpt-oss-120b",\n  max_tokens: 1024,\n  messages: [{ role: "user", content: "Olá, Shtora." }],\n});`,
	cURL: (origin: string) =>
		`curl "${origin}/v1/chat/completions" \\\n  -H "Authorization: Bearer $SHTORA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "shtora/gpt-oss-120b",\n    "messages": [{ role: "user", content: "Olá, Shtora." }]\n  }'`,
};

export function IntegrationCode() {
	const [selected, setSelected] = useState<keyof typeof examples>("OpenAI");
	const [origin, setOrigin] = useState("https://SEU-DOMINIO");
	const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
		"idle",
	);
	const id = useId();
	useEffect(() => setOrigin(window.location.origin), []);
	const code = examples[selected](origin);

	async function copy() {
		try {
			await navigator.clipboard.writeText(code);
			setCopyState("copied");
		} catch {
			setCopyState("error");
		}
	}

	return (
		<div className="min-w-0 overflow-hidden rounded-[5px] border border-[#2a2b2e] bg-[#111214]">
			<div className="flex items-center justify-between gap-2 border-b border-[#2a2b2e] px-[15px] max-[480px]:px-2">
				<fieldset
					className="m-0 flex min-w-0 border-0 p-0"
					aria-label="Exemplo de integração"
				>
					{(Object.keys(examples) as (keyof typeof examples)[]).map((name) => (
						<button
							key={name}
							type="button"
							className={cn(
								"border-0 border-b border-transparent bg-transparent px-3 py-[15px] text-[13px] text-[#aaa6a1] max-[480px]:px-[10px]",
								FOCUS_VISIBLE,
								selected === name && "border-b-[#e3ab88] text-[#e3ab88]",
							)}
							aria-pressed={selected === name}
							aria-controls={id}
							onClick={() => {
								setSelected(name);
								setCopyState("idle");
							}}
						>
							{name}
						</button>
					))}
				</fieldset>
				<button
					className={cn(
						"inline-flex items-center gap-[7px] border-0 bg-transparent px-[2px] py-[10px] text-xs text-[#aaa6a1]",
						FOCUS_VISIBLE,
					)}
					type="button"
					onClick={copy}
					aria-label="Copiar exemplo de integração"
				>
					{copyState === "copied" ? (
						<Check size={15} aria-hidden="true" />
					) : (
						<Copy size={15} aria-hidden="true" />
					)}
					<span className="max-[480px]:hidden">
						{copyState === "copied" ? "Copiado" : "Copiar"}
					</span>
				</button>
			</div>
			<section aria-label={`Código ${selected}`}>
				<pre
					className={cn(
						MONO,
						"m-0 min-h-[270px] overflow-x-auto p-[22px] text-[13px] leading-[1.85] text-[#d4c6b8] max-[480px]:px-4 max-[480px]:py-[18px] max-[480px]:text-xs",
					)}
					id={id}
				>
					<code>{code}</code>
				</pre>
			</section>
			<div
				className={cn(
					MONO,
					"flex flex-col gap-1 border-t border-[#2a2b2e] px-[22px] py-[14px] text-[11.5px] leading-[1.6] text-[#aaa6a1] max-[480px]:px-4",
				)}
			>
				<span className="text-[#c8a487]">
					{selected === "Anthropic"
						? "POST /v1/messages"
						: "POST /v1/chat/completions"}
				</span>
				<span role="status">
					{copyState === "error"
						? "Não foi possível copiar. Selecione o código e copie manualmente."
						: copyState === "copied"
							? "Código copiado para a área de transferência."
							: "Suas credenciais ficam no ambiente da aplicação."}
				</span>
			</div>
		</div>
	);
}

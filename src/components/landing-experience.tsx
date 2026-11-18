"use client";

import { Check, Copy } from "lucide-react";
import Image from "next/image";
import { createRef, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatedBeam } from "@/components/magicui/animated-beam";

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
		rule: "Fallback automático em cadeia",
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
			className="request-layers"
			id="como-funciona"
			aria-label="Como funciona o roteamento"
		>
			<div className="landing-wrap">
				<div className="mindmap-head">
					<div>
						<p className="landing-eyebrow">
							<span className="status-dot" /> MAPA MENTAL DE ROTEAMENTO
						</p>
						<h2>
							O caminho da sua
							<br />
							<span>requisição.</span>
						</h2>
					</div>
					<p className="mindmap-subtitle">
						Um único endpoint ramifica sua chamada pelo gateway <code>s.</code>{" "}
						até 49 provedores gratuitos — com pool comunitário e failover
						silencioso. Clique ou passe o cursor para inspecionar uma rota.
					</p>
				</div>

				<div className="mindmap-canvas">
					<div className="mindmap-stage" ref={stageRef}>
						<div className="mindmap-beams" aria-hidden="true">
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

						<div className="mindmap-vertical">
							<div className="mindmap-tier-origin">
								<div className="mindmap-node-bezel" ref={originRef}>
									<div className="mindmap-origin-card">
										<span className="mindmap-node-kicker">ENTRADA ÚNICA</span>
										<strong>Sua Aplicação</strong>
										<code>POST /v1/chat/completions</code>
										<span className="mindmap-origin-model">
											model: &ldquo;shtora/&lt;modelo&gt;&rdquo;
										</span>
									</div>
								</div>
							</div>

							<div className="mindmap-mobile-stem" aria-hidden="true" />

							<div className="mindmap-tier-hub">
								<div className="mindmap-hub-bezel" ref={hubRef}>
									<div className="mindmap-hub-core">
										<span className="mindmap-hub-mark" aria-hidden="true">
											s.
										</span>
										<strong>Shtora Cloud</strong>
										<span className="mindmap-hub-meta">
											Pool · Failover · Grátis
										</span>
									</div>
								</div>
							</div>

							<div className="mindmap-mobile-stem" aria-hidden="true" />

							<ul className="mindmap-branches">
								{ROUTING_BRANCHES.map((branch, index) => {
									const isBranchActive = branch.id === activeBranch.id;
									return (
										<li
											key={branch.id}
											className={`mindmap-branch-col${isBranchActive ? " is-active" : ""}`}
										>
											<button
												ref={branchRefs[index]}
												type="button"
												className="mindmap-branch-node"
												aria-pressed={isBranchActive}
												onClick={() => selectBranch(branch)}
												onMouseEnter={() => selectBranch(branch)}
											>
												<span className="branch-title">{branch.title}</span>
												<span className="branch-rule">{branch.rule}</span>
											</button>

											<div className="mindmap-leaves">
												{branch.providers.map((provider) => {
													const isProviderActive =
														isBranchActive &&
														provider.slug === activeProvider.slug;
													return (
														<button
															key={provider.slug}
															type="button"
															className={`mindmap-leaf${isProviderActive ? " is-active" : ""}`}
															aria-pressed={isProviderActive}
															onClick={() => selectProvider(branch, provider)}
															onMouseEnter={() =>
																selectProvider(branch, provider)
															}
														>
															<span className="mindmap-leaf-icon">
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

					<div className="mindmap-inspector" role="status" aria-live="polite">
						<div className="inspector-trace">
							<span className="inspector-step">Sua Aplicação</span>
							<span className="inspector-sep" aria-hidden="true">
								→
							</span>
							<span className="inspector-step inspector-hub">s. Gateway</span>
							<span className="inspector-sep" aria-hidden="true">
								→
							</span>
							<span className="inspector-step">{activeBranch.title}</span>
							<span className="inspector-sep" aria-hidden="true">
								→
							</span>
							<span className="inspector-provider">
								<span className="mindmap-leaf-icon is-small">
									<Image
										src={`/providers/${activeProvider.slug}.png`}
										width={14}
										height={14}
										alt=""
										aria-hidden="true"
										unoptimized
									/>
								</span>
								<strong>{activeProvider.name}</strong>
							</span>
						</div>
						<p className="inspector-detail">
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
		`curl "${origin}/v1/chat/completions" \\\n  -H "Authorization: Bearer $SHTORA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "shtora/gpt-oss-120b",\n    "messages": [{ "role": "user", "content": "Olá, Shtora." }]\n  }'`,
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
		<div className="integration-code">
			<div className="code-toolbar">
				<fieldset className="code-options" aria-label="Exemplo de integração">
					{(Object.keys(examples) as (keyof typeof examples)[]).map((name) => (
						<button
							key={name}
							type="button"
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
					className="copy-code"
					type="button"
					onClick={copy}
					aria-label="Copiar exemplo de integração"
				>
					{copyState === "copied" ? (
						<Check size={15} aria-hidden="true" />
					) : (
						<Copy size={15} aria-hidden="true" />
					)}
					<span>{copyState === "copied" ? "Copiado" : "Copiar"}</span>
				</button>
			</div>
			<section aria-label={`Código ${selected}`} className="code-scroll">
				<pre id={id}>
					<code>{code}</code>
				</pre>
			</section>
			<div className="code-foot">
				<span>
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
